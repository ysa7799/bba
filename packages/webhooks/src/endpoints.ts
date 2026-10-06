import { webhookEndpoints, type TenantTx, type WebhookEndpoint } from '@businessos/database';
import { checkWebhookUrl, HttpRequestError } from '@businessos/safe-http';
import {
  ConflictError,
  newId,
  NotFoundError,
  ValidationError,
  type SecretBox,
} from '@businessos/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from './catalogue';
import { generateWebhookSecret } from './signing';

/** Endpoints an organization may have. */
export const MAX_ENDPOINTS = 20;
/** After a rotation the previous secret keeps signing this long. */
export const SECRET_OVERLAP_MS = 24 * 3_600_000;

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .transform((events) => [...new Set(events)]);

export const createEndpointInputSchema = z.object({
  url: z.string().trim().min(8).max(2_000),
  description: z.string().trim().max(500).nullable().optional(),
  events: eventsSchema,
});
export type CreateEndpointInput = z.input<typeof createEndpointInputSchema>;

export const updateEndpointInputSchema = z.object({
  url: z.string().trim().min(8).max(2_000).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  events: eventsSchema.optional(),
  /** Turning an endpoint back on also clears its failure count. */
  enabled: z.boolean().optional(),
});
export type UpdateEndpointInput = z.input<typeof updateEndpointInputSchema>;

/** Where deliveries may go (the same SSRF rules as workflow webhook actions). */
export interface UrlPolicy {
  /** Development and tests only. */
  allowPrivateNetwork: boolean;
  /** BusinessOS's own hosts: an endpoint there could feed events back into itself. */
  ownHosts: readonly string[];
}

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'active' | 'disabled';
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export function endpointView(row: WebhookEndpoint): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    status: row.status,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function checkedUrl(raw: string, policy: UrlPolicy): string {
  try {
    return checkWebhookUrl(raw, policy.allowPrivateNetwork, policy.ownHosts).toString();
  } catch (error) {
    const message = error instanceof HttpRequestError ? error.message : 'Invalid URL';
    throw new ValidationError('Invalid webhook URL', [{ path: 'url', message }]);
  }
}

function requireSecretBox(secretBox: SecretBox | null): SecretBox {
  if (!secretBox) throw new ConflictError('Credential encryption is not configured');
  return secretBox;
}

/** Associated data binding a sealed secret to its organization and endpoint. */
function secretContext(organizationId: string, endpointId: string): string {
  return `${organizationId}:webhook:${endpointId}`;
}

/** The secrets that sign deliveries now: the current one, plus the previous during overlap. */
export function signingSecrets(
  row: WebhookEndpoint,
  secretBox: SecretBox | null,
  now: Date = new Date(),
): string[] {
  const box = requireSecretBox(secretBox);
  const context = secretContext(row.organizationId, row.id);
  const secrets = [box.decrypt(row.secretSealed, context)];
  if (
    row.previousSecretSealed &&
    row.previousSecretExpiresAt &&
    row.previousSecretExpiresAt > now
  ) {
    secrets.push(box.decrypt(row.previousSecretSealed, context));
  }
  return secrets;
}

async function findEndpoint(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<WebhookEndpoint> {
  const [row] = await tx
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)));
  if (!row) throw new NotFoundError('Webhook endpoint');
  return row;
}

/** Creates an endpoint and returns its signing secret **once** (stored encrypted). */
export async function createWebhookEndpoint(
  tx: TenantTx,
  scope: { organizationId: string; userId: string },
  secretBox: SecretBox | null,
  policy: UrlPolicy,
  rawInput: CreateEndpointInput,
): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  const input = createEndpointInputSchema.parse(rawInput);
  const url = checkedUrl(input.url, policy);
  const box = requireSecretBox(secretBox);
  // Serializes creation per organization so the endpoint limit holds under concurrency.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`webhooks:${scope.organizationId}`}, 0))`,
  );
  const [existing] = await tx
    .select({ n: count() })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, scope.organizationId));
  if ((existing?.n ?? 0) >= MAX_ENDPOINTS) {
    throw new ConflictError(`An organization can have at most ${MAX_ENDPOINTS} webhook endpoints`);
  }
  const id = newId();
  const secret = generateWebhookSecret();
  const [row] = await tx
    .insert(webhookEndpoints)
    .values({
      id,
      organizationId: scope.organizationId,
      url,
      description: input.description ?? null,
      events: input.events,
      secretSealed: box.encrypt(secret, secretContext(scope.organizationId, id)),
      createdByUserId: scope.userId,
    })
    .returning();
  if (!row) throw new Error('Webhook endpoint was not created');
  return { endpoint: endpointView(row), secret };
}

export async function listWebhookEndpoints(
  tx: TenantTx,
  organizationId: string,
): Promise<WebhookEndpointView[]> {
  const rows = await tx
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, organizationId))
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
    .limit(MAX_ENDPOINTS);
  return rows.map(endpointView);
}

export async function getWebhookEndpoint(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<WebhookEndpointView> {
  return endpointView(await findEndpoint(tx, organizationId, id));
}

export async function updateWebhookEndpoint(
  tx: TenantTx,
  organizationId: string,
  id: string,
  policy: UrlPolicy,
  rawInput: UpdateEndpointInput,
): Promise<{ endpoint: WebhookEndpointView; changedFields: string[] }> {
  const input = updateEndpointInputSchema.parse(rawInput);
  const current = await findEndpoint(tx, organizationId, id);
  const changes: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (input.url !== undefined) changes.url = checkedUrl(input.url, policy);
  if (input.description !== undefined) changes.description = input.description;
  if (input.events !== undefined) changes.events = input.events;
  if (input.enabled === true && current.status === 'disabled') {
    Object.assign(changes, { status: 'active', disabledReason: null, consecutiveFailures: 0 });
  }
  if (input.enabled === false && current.status === 'active') {
    Object.assign(changes, { status: 'disabled', disabledReason: 'manual' });
  }
  const changedFields = Object.keys(changes);
  if (changedFields.length === 0) return { endpoint: endpointView(current), changedFields };
  const [row] = await tx
    .update(webhookEndpoints)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning();
  if (!row) throw new NotFoundError('Webhook endpoint');
  return { endpoint: endpointView(row), changedFields };
}

/** Deletes an endpoint and its delivery history. */
export async function deleteWebhookEndpoint(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<WebhookEndpointView> {
  const [row] = await tx
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning();
  if (!row) throw new NotFoundError('Webhook endpoint');
  return endpointView(row);
}

/**
 * Replaces the signing secret and returns the new one **once**. The previous secret keeps
 * signing for a day so receivers can switch without rejecting deliveries.
 */
export async function rotateWebhookSecret(
  tx: TenantTx,
  organizationId: string,
  id: string,
  secretBox: SecretBox | null,
  now: Date = new Date(),
): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  const box = requireSecretBox(secretBox);
  const current = await findEndpoint(tx, organizationId, id);
  const secret = generateWebhookSecret();
  const [row] = await tx
    .update(webhookEndpoints)
    .set({
      secretSealed: box.encrypt(secret, secretContext(organizationId, id)),
      previousSecretSealed: current.secretSealed,
      previousSecretExpiresAt: new Date(now.getTime() + SECRET_OVERLAP_MS),
      updatedAt: now,
    })
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning();
  if (!row) throw new NotFoundError('Webhook endpoint');
  return { endpoint: endpointView(row), secret };
}
