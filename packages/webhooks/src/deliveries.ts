import { canUseFeature } from '@businessos/billing';
import {
  webhookDeliveries,
  webhookEndpoints,
  withSystem,
  withTenant,
  type Database,
  type TenantTx,
  type WebhookDelivery,
} from '@businessos/database';
import type { DomainEvent, EventSubscriber } from '@businessos/events';
import { HttpRequestError, postBody, type Resolver } from '@businessos/safe-http';
import {
  ConflictError,
  decodeCursor,
  encodeCursor,
  newId,
  NotFoundError,
  type SecretBox,
} from '@businessos/shared';
import { and, arrayContains, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  envelopeFor,
  isWebhookEventType,
  TEST_EVENT_TYPE,
  WEBHOOK_EVENT_TYPES,
  type WebhookEnvelope,
} from './catalogue';
import type { UrlPolicy } from './endpoints';
import { signingSecrets } from './endpoints';
import { SIGNATURE_HEADER, signatureHeader } from './signing';

/** Waits before each retry: about 45 hours from the first attempt to the last. */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** An endpoint whose deliveries keep failing in full is turned off after this many in a row. */
export const DISABLE_AFTER_FAILED_DELIVERIES = 15;
/** Deliveries are kept this long. */
export const DELIVERY_RETENTION_MS = 30 * 86_400_000;
/** A claimed attempt that never reported back is retried after this long (crashed worker). */
const ATTEMPT_LEASE_MS = 10 * 60_000;
const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookServices extends UrlPolicy {
  db: Database;
  secretBox: SecretBox | null;
  /** Queues one attempt; the job id makes a duplicate request harmless. */
  enqueueAttempt(job: {
    organizationId: string;
    deliveryId: string;
    attempt: number;
    jobId: string;
    delayMs: number;
  }): Promise<void>;
  /** Tests: substitute DNS resolution. */
  resolver?: Resolver;
  timeoutMs?: number;
}

export function attemptJobId(deliveryId: string, attempt: number, suffix?: string): string {
  return `webhook-${deliveryId}-${attempt}${suffix ? `-${suffix}` : ''}`;
}

/**
 * Creates one delivery per active endpoint subscribed to the event (when the organization's
 * plan includes the API) and queues their first attempts. Safe to run again for the same event.
 */
export async function createDeliveriesForEvent(
  services: WebhookServices,
  event: DomainEvent,
): Promise<number> {
  const organizationId = event.organizationId;
  if (!organizationId || !isWebhookEventType(event.type)) return 0;
  const type = event.type;
  const pending = await withTenant(services.db, { organizationId, userId: null }, async (tx) => {
    if (!(await canUseFeature(tx, organizationId, 'api.enabled'))) return [];
    const endpoints = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.status, 'active'),
          arrayContains(webhookEndpoints.events, [type]),
        ),
      );
    if (endpoints.length === 0) return [];
    const body = JSON.stringify(envelopeFor(event, organizationId));
    const now = new Date();
    await tx
      .insert(webhookDeliveries)
      .values(
        endpoints.map((endpoint) => ({
          organizationId,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: type,
          body,
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing();
    // Also re-queues first attempts a crashed earlier run created but never queued.
    return tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.organizationId, organizationId),
          eq(webhookDeliveries.eventId, event.id),
          eq(webhookDeliveries.status, 'pending'),
          eq(webhookDeliveries.attempts, 0),
          inArray(
            webhookDeliveries.endpointId,
            endpoints.map((endpoint) => endpoint.id),
          ),
        ),
      );
  });
  for (const delivery of pending) {
    await services.enqueueAttempt({
      organizationId,
      deliveryId: delivery.id,
      attempt: 1,
      jobId: attemptJobId(delivery.id, 1),
      delayMs: 0,
    });
  }
  return pending.length;
}

export function createWebhookSubscriber(services: WebhookServices): EventSubscriber {
  return {
    name: 'webhooks',
    events: WEBHOOK_EVENT_TYPES,
    handle: async (event) => {
      await createDeliveriesForEvent(services, event);
    },
  };
}

/** Creates a `webhook.test` delivery for an endpoint (the caller queues it after commit). */
export async function createTestDelivery(
  tx: TenantTx,
  organizationId: string,
  endpointId: string,
): Promise<WebhookDelivery> {
  const [endpoint] = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, endpointId)),
    );
  if (!endpoint) throw new NotFoundError('Webhook endpoint');
  if (endpoint.status !== 'active') throw new ConflictError('Turn the endpoint on first');
  const eventId = newId();
  const envelope: WebhookEnvelope = {
    id: eventId,
    type: TEST_EVENT_TYPE,
    version: 1,
    createdAt: new Date().toISOString(),
    organizationId,
    subject: { type: 'webhook_endpoint', id: endpointId },
    data: { message: 'This is a test event from BusinessOS.' },
  };
  const [delivery] = await tx
    .insert(webhookDeliveries)
    .values({
      organizationId,
      endpointId,
      eventId,
      eventType: TEST_EVENT_TYPE,
      body: JSON.stringify(envelope),
      nextAttemptAt: new Date(),
    })
    .returning();
  if (!delivery) throw new Error('Test delivery was not created');
  return delivery;
}

/** Sends a finished or failed delivery again (the caller queues the returned attempt). */
export async function prepareRedelivery(
  tx: TenantTx,
  organizationId: string,
  endpointId: string,
  deliveryId: string,
): Promise<{ attempt: number }> {
  const [found] = await tx
    .select({ delivery: webhookDeliveries, endpointStatus: webhookEndpoints.status })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      and(
        eq(webhookEndpoints.id, webhookDeliveries.endpointId),
        eq(webhookEndpoints.organizationId, webhookDeliveries.organizationId),
      ),
    )
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    )
    .for('update', { of: webhookDeliveries });
  if (!found) throw new NotFoundError('Delivery');
  if (found.endpointStatus !== 'active') throw new ConflictError('Turn the endpoint on first');
  await tx
    .update(webhookDeliveries)
    .set({ status: 'pending', nextAttemptAt: new Date(), completedAt: null, updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, deliveryId));
  return { attempt: found.delivery.attempts + 1 };
}

export type AttemptOutcome = 'succeeded' | 'retrying' | 'failed' | 'skipped';

function clipError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

/**
 * Makes one delivery attempt: claims it (only the expected attempt number, so duplicate or
 * stale jobs do nothing), signs the stored body with the endpoint's secrets, POSTs it, then
 * records the result. Failures schedule the next attempt; the last failure (or a permanent
 * one) marks the delivery failed and may turn a persistently failing endpoint off.
 */
export async function attemptDelivery(
  services: WebhookServices,
  job: { organizationId: string; deliveryId: string; attempt: number },
  now: Date = new Date(),
): Promise<AttemptOutcome> {
  const { organizationId, deliveryId } = job;
  const scope = { organizationId, userId: null };
  const claimed = await withTenant(services.db, scope, async (tx) => {
    const [found] = await tx
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(
        webhookEndpoints,
        and(
          eq(webhookEndpoints.id, webhookDeliveries.endpointId),
          eq(webhookEndpoints.organizationId, webhookDeliveries.organizationId),
        ),
      )
      .where(
        and(
          eq(webhookDeliveries.organizationId, organizationId),
          eq(webhookDeliveries.id, deliveryId),
        ),
      )
      .for('update', { of: webhookDeliveries });
    if (found?.delivery.status !== 'pending' || found.delivery.attempts !== job.attempt - 1) {
      return null;
    }
    if (found.endpoint.status !== 'active') {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'failed',
          lastError: 'The endpoint is turned off',
          nextAttemptAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      return 'endpoint-off' as const;
    }
    await tx
      .update(webhookDeliveries)
      .set({
        attempts: job.attempt,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return found;
  });
  if (claimed === null) return 'skipped';
  if (claimed === 'endpoint-off') return 'failed';
  const { delivery, endpoint } = claimed;

  let status: number | null = null;
  let error: HttpRequestError | null = null;
  const started = Date.now();
  try {
    const secrets = signingSecrets(endpoint, services.secretBox, now);
    const result = await postBody(endpoint.url, delivery.body, {
      allowPrivateNetwork: services.allowPrivateNetwork,
      ownHosts: services.ownHosts,
      ...(services.resolver ? { resolver: services.resolver } : {}),
      timeoutMs: services.timeoutMs ?? DELIVERY_TIMEOUT_MS,
      userAgent: 'BusinessOS-Webhooks/1',
      headers: {
        [SIGNATURE_HEADER]: signatureHeader(secrets, delivery.body, now),
        'businessos-event-id': delivery.eventId,
        'businessos-event-type': delivery.eventType,
        'businessos-delivery-id': delivery.id,
        'businessos-delivery-attempt': String(job.attempt),
      },
    });
    status = result.status;
  } catch (caught) {
    error =
      caught instanceof HttpRequestError
        ? caught
        : new HttpRequestError('The delivery could not be sent', true);
    status = error.status;
  }
  const durationMs = Date.now() - started;
  const finishedAt = new Date();

  const recorded = await withTenant(services.db, scope, async (tx) => {
    const own = and(
      eq(webhookDeliveries.organizationId, organizationId),
      eq(webhookDeliveries.id, deliveryId),
    );
    const endpointRow = and(
      eq(webhookEndpoints.organizationId, organizationId),
      eq(webhookEndpoints.id, endpoint.id),
    );
    if (!error) {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          responseStatus: status,
          durationMs,
          lastError: null,
          nextAttemptAt: null,
          completedAt: finishedAt,
          updatedAt: finishedAt,
        })
        .where(own);
      await tx
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0 })
        .where(and(endpointRow, sql`${webhookEndpoints.consecutiveFailures} > 0`));
      return { outcome: 'succeeded' as const, retryInMs: null };
    }

    const isTest = delivery.eventType === TEST_EVENT_TYPE;
    const gone = error.status === 410;
    // Refused destinations (private addresses, invalid URLs) will not start working by waiting.
    const permanent = gone || (!error.retryable && error.status === null);
    const failure = {
      responseStatus: status,
      durationMs,
      lastError: clipError(error.message),
      updatedAt: finishedAt,
    };
    if (!isTest && !permanent && job.attempt < MAX_ATTEMPTS) {
      const retryInMs = RETRY_DELAYS_MS[job.attempt - 1] ?? RETRY_DELAYS_MS[0];
      await tx
        .update(webhookDeliveries)
        .set({ ...failure, nextAttemptAt: new Date(finishedAt.getTime() + retryInMs) })
        .where(own);
      return { outcome: 'retrying' as const, retryInMs };
    }
    await tx
      .update(webhookDeliveries)
      .set({ ...failure, status: 'failed', nextAttemptAt: null, completedAt: finishedAt })
      .where(own);
    if (!isTest) {
      const [updated] = await tx
        .update(webhookEndpoints)
        .set({ consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1` })
        .where(endpointRow)
        .returning({ failures: webhookEndpoints.consecutiveFailures });
      if (gone || (updated?.failures ?? 0) >= DISABLE_AFTER_FAILED_DELIVERIES) {
        await tx
          .update(webhookEndpoints)
          .set({ status: 'disabled', disabledReason: 'failing', updatedAt: finishedAt })
          .where(and(endpointRow, eq(webhookEndpoints.status, 'active')));
      }
    }
    return { outcome: 'failed' as const, retryInMs: null };
  });
  // Queued after the result is committed; if queuing fails, maintenance re-queues the attempt
  // once it is overdue.
  if (recorded.retryInMs !== null) {
    await services.enqueueAttempt({
      organizationId,
      deliveryId,
      attempt: job.attempt + 1,
      jobId: attemptJobId(deliveryId, job.attempt + 1),
      delayMs: recorded.retryInMs,
    });
  }
  return recorded.outcome;
}

export const deliveryListQuerySchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function deliveryView(row: WebhookDelivery): DeliveryView {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    durationMs: row.durationMs,
    nextAttemptAt: row.status === 'pending' ? (row.nextAttemptAt?.toISOString() ?? null) : null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** An endpoint's deliveries, newest first. */
export async function listDeliveries(
  tx: TenantTx,
  organizationId: string,
  endpointId: string,
  rawQuery: z.input<typeof deliveryListQuerySchema>,
): Promise<{ data: DeliveryView[]; nextCursor: string | null }> {
  const query = deliveryListQuerySchema.parse(rawQuery);
  const conditions: (SQL | undefined)[] = [
    eq(webhookDeliveries.organizationId, organizationId),
    eq(webhookDeliveries.endpointId, endpointId),
  ];
  if (query.status) conditions.push(eq(webhookDeliveries.status, query.status));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, z.object({ v: z.string().max(40), id: z.uuid() }));
    conditions.push(
      sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({
      row: webhookDeliveries,
      sortValue: sql<string>`${webhookDeliveries.createdAt}::text`,
    })
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((entry) => deliveryView(entry.row)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: last.sortValue, id: last.row.id })
        : null,
  };
}

/** One delivery with the exact body that was (or will be) sent. */
export async function getDelivery(
  tx: TenantTx,
  organizationId: string,
  endpointId: string,
  deliveryId: string,
): Promise<DeliveryView & { body: string }> {
  const [row] = await tx
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    );
  if (!row) throw new NotFoundError('Delivery');
  return { ...deliveryView(row), body: row.body };
}

/**
 * Upkeep (worker): queues attempts whose job was lost (overdue by more than the lease) and
 * removes deliveries past retention.
 */
export async function runWebhookMaintenance(
  services: WebhookServices,
  now: Date = new Date(),
): Promise<{ requeued: number; pruned: number }> {
  // System scope: upkeep spans organizations; every change targets rows by id.
  const overdue = await withSystem(services.db, (tx) =>
    tx
      .select({
        id: webhookDeliveries.id,
        organizationId: webhookDeliveries.organizationId,
        attempts: webhookDeliveries.attempts,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lt(webhookDeliveries.nextAttemptAt, new Date(now.getTime() - ATTEMPT_LEASE_MS)),
        ),
      )
      .limit(500),
  );
  const stamp = String(Math.floor(now.getTime() / 60_000));
  for (const delivery of overdue) {
    if (delivery.attempts >= MAX_ATTEMPTS) {
      // System scope: see above.
      await withSystem(services.db, (tx) =>
        tx
          .update(webhookDeliveries)
          .set({
            status: 'failed',
            lastError: 'No answer was recorded for the last attempt',
            nextAttemptAt: null,
            completedAt: now,
          })
          .where(
            and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'pending')),
          ),
      );
      continue;
    }
    await services.enqueueAttempt({
      organizationId: delivery.organizationId,
      deliveryId: delivery.id,
      attempt: delivery.attempts + 1,
      jobId: attemptJobId(delivery.id, delivery.attempts + 1, `s${stamp}`),
      delayMs: 0,
    });
  }
  let pruned = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    // System scope: retention applies to every organization alike.
    const removed = await withSystem(services.db, async (tx) => {
      const old = await tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(lt(webhookDeliveries.createdAt, new Date(now.getTime() - DELIVERY_RETENTION_MS)))
        .limit(2_000);
      if (old.length === 0) return 0;
      await tx.delete(webhookDeliveries).where(
        inArray(
          webhookDeliveries.id,
          old.map((row) => row.id),
        ),
      );
      return old.length;
    });
    pruned += removed;
    if (removed < 2_000) break;
  }
  return { requeued: overdue.length, pruned };
}
