import {
  entitlementOverrides,
  webhookDeliveries,
  webhookEndpoints,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type TenantTx,
} from '@businessos/database';
import type { DomainEvent } from '@businessos/events';
import { NotFoundError, SecretBox, ValidationError, newId } from '@businessos/shared';
import { createTestDatabase, createTestWorld, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attemptDelivery,
  computeSignature,
  createDeliveriesForEvent,
  createTestDelivery,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  DISABLE_AFTER_FAILED_DELIVERIES,
  getDelivery,
  getWebhookEndpoint,
  listDeliveries,
  listWebhookEndpoints,
  MAX_ATTEMPTS,
  prepareRedelivery,
  RETRY_DELAYS_MS,
  rotateWebhookSecret,
  runWebhookMaintenance,
  signatureHeader,
  updateWebhookEndpoint,
  verifyWebhookSignature,
  type WebhookServices,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
let server: Server;
let receiverUrl = '';
/** What the receiver answers next (by default 204). */
let answer = 204;
const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
let queued: { deliveryId: string; attempt: number; jobId: string; delayMs: number }[] = [];
let services: WebhookServices;
const secretBox = new SecretBox([{ id: 't1', key: Buffer.alloc(32, 9) }]);

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
  // Organization A's plan includes the API; organization B's does not.
  await withSystem(handle.db, (tx) =>
    tx.insert(entitlementOverrides).values([
      {
        organizationId: world.orgA.organization.id,
        key: 'api.enabled',
        value: { value: true },
        reason: 'webhook tests',
      },
      {
        organizationId: world.orgB.organization.id,
        key: 'api.enabled',
        value: { value: false },
        reason: 'webhook tests',
      },
    ]),
  );
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ body, headers: request.headers });
      response.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  services = {
    db: handle.db,
    secretBox,
    allowPrivateNetwork: true,
    ownHosts: ['api.businessos.example'],
    enqueueAttempt: (job) => {
      queued.push(job);
      return Promise.resolve();
    },
  };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await handle.close();
});

beforeEach(() => {
  queued = [];
  received.length = 0;
  answer = 204;
});

const A = () => world.orgA.organization.id;
const B = () => world.orgB.organization.id;
const policy = { allowPrivateNetwork: true, ownHosts: ['api.businessos.example'] };

function asOwner<T>(org: 'A' | 'B', fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const entry = org === 'A' ? world.orgA : world.orgB;
  return withTenant(
    handle.db,
    { organizationId: entry.organization.id, userId: entry.users.owner.id },
    fn,
  );
}

async function endpoint(org: 'A' | 'B' = 'A', events = ['contact.created', 'deal.won']) {
  const entry = org === 'A' ? world.orgA : world.orgB;
  return asOwner(org, (tx) =>
    createWebhookEndpoint(
      tx,
      { organizationId: entry.organization.id, userId: entry.users.owner.id },
      secretBox,
      policy,
      { url: receiverUrl, events: events as ['contact.created'] },
    ),
  );
}

function contactCreated(organizationId: string): DomainEvent {
  const contactId = newId();
  return {
    id: newId(),
    type: 'contact.created',
    version: 1,
    organizationId,
    occurredAt: new Date(),
    actor: { type: 'user', id: null },
    subject: { type: 'contact', id: contactId },
    correlationId: null,
    causationId: null,
    payload: { contactId },
  };
}

async function deliveryRow(id: string) {
  const [row] = await withSystem(handle.db, (tx) =>
    tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)),
  );
  return row;
}

async function endpointRow(id: string) {
  const [row] = await withSystem(handle.db, (tx) =>
    tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)),
  );
  return row;
}

describe('signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"contact.created"}';
  const now = new Date('2026-10-05T12:00:00Z');

  it('verifies the exact body within the time tolerance', () => {
    const header = signatureHeader([secret], body, now);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ body, header, secret, now })).toBe(true);
    // Tampered body, wrong secret, missing header.
    expect(verifyWebhookSignature({ body: `${body} `, header, secret, now })).toBe(false);
    expect(verifyWebhookSignature({ body, header, secret: 'whsec_other', now })).toBe(false);
    expect(verifyWebhookSignature({ body, header: null, secret, now })).toBe(false);
    expect(verifyWebhookSignature({ body, header: 'v1=abc', secret, now })).toBe(false);
  });

  it('refuses replays outside the tolerance and forged timestamps', () => {
    const header = signatureHeader([secret], body, now);
    const later = new Date(now.getTime() + 301_000);
    expect(verifyWebhookSignature({ body, header, secret, now: later })).toBe(false);
    // A fresh timestamp glued onto an old signature does not verify.
    const signature = header.split(',')[1];
    const forged = `t=${Math.floor(later.getTime() / 1000)},${signature}`;
    expect(verifyWebhookSignature({ body, header: forged, secret, now: later })).toBe(false);
  });

  it('signs with every active secret during a rotation', () => {
    const header = signatureHeader(['whsec_new', 'whsec_old'], body, now);
    expect(header.split(',')).toHaveLength(3);
    expect(verifyWebhookSignature({ body, header, secret: 'whsec_new', now })).toBe(true);
    expect(verifyWebhookSignature({ body, header, secret: 'whsec_old', now })).toBe(true);
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(header).toContain(`v1=${computeSignature('whsec_old', timestamp, body)}`);
  });
});

describe('endpoints', () => {
  it('returns the secret once and stores it encrypted', async () => {
    const { endpoint: created, secret } = await endpoint();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ url: receiverUrl, status: 'active', consecutiveFailures: 0 });
    expect(JSON.stringify(created)).not.toContain(secret);
    const row = await endpointRow(created.id);
    expect(row?.secretSealed).not.toContain(secret);
    expect(secretBox.decrypt(row?.secretSealed ?? '', `${A()}:webhook:${created.id}`)).toBe(secret);
  });

  it('refuses unsafe URLs and unknown events', async () => {
    const strict = { allowPrivateNetwork: false, ownHosts: ['api.businessos.example'] };
    const scope = { organizationId: A(), userId: world.orgA.users.owner.id };
    for (const url of [
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://localhost/x',
      'https://user:pass@hooks.example.com/x',
      'https://api.businessos.example/webhooks',
    ]) {
      await expect(
        asOwner('A', (tx) =>
          createWebhookEndpoint(tx, scope, secretBox, strict, { url, events: ['deal.won'] }),
        ),
        url,
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      asOwner('A', (tx) =>
        createWebhookEndpoint(tx, scope, secretBox, strict, {
          url: 'https://hooks.example.com/x',
          events: ['member.invited' as 'deal.won'],
        }),
      ),
    ).rejects.toThrow();
  });

  it('turns on and off, and rotates secrets with a day of overlap', async () => {
    const { endpoint: created, secret: first } = await endpoint();
    const off = await asOwner('A', (tx) =>
      updateWebhookEndpoint(tx, A(), created.id, policy, { enabled: false }),
    );
    expect(off.endpoint).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    const on = await asOwner('A', (tx) =>
      updateWebhookEndpoint(tx, A(), created.id, policy, { enabled: true, events: ['deal.lost'] }),
    );
    expect(on.endpoint).toMatchObject({ status: 'active', disabledReason: null });
    expect(on.changedFields.sort()).toEqual(
      ['consecutiveFailures', 'disabledReason', 'events', 'status'].sort(),
    );

    const { secret: second } = await asOwner('A', (tx) =>
      rotateWebhookSecret(tx, A(), created.id, secretBox),
    );
    expect(second).not.toBe(first);
    const { signingSecrets } = await import('../src');
    const row = await endpointRow(created.id);
    if (!row) throw new Error('missing endpoint');
    expect(signingSecrets(row, secretBox)).toEqual([second, first]);
    expect(signingSecrets(row, secretBox, new Date(Date.now() + 25 * 3_600_000))).toEqual([second]);
  });

  it('keeps endpoints inside their organization', async () => {
    const { endpoint: created } = await endpoint('A');
    const listedByB = await asOwner('B', (tx) => listWebhookEndpoints(tx, B()));
    expect(listedByB.some((entry) => entry.id === created.id)).toBe(false);
    const attempts: ((tx: TenantTx) => Promise<unknown>)[] = [
      (tx: TenantTx) => getWebhookEndpoint(tx, B(), created.id),
      (tx: TenantTx) => getWebhookEndpoint(tx, A(), created.id),
      (tx: TenantTx) => updateWebhookEndpoint(tx, A(), created.id, policy, { enabled: false }),
      (tx: TenantTx) => rotateWebhookSecret(tx, A(), created.id, secretBox),
      (tx: TenantTx) => deleteWebhookEndpoint(tx, A(), created.id),
      (tx: TenantTx) => createTestDelivery(tx, A(), created.id),
    ];
    for (const attempt of attempts) {
      // In organization B's scope, organization A's endpoint does not exist (RLS + filters).
      await expect(asOwner('B', attempt)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await endpointRow(created.id))?.status).toBe('active');
  });
});

describe('deliveries', () => {
  it('fans an event out to subscribed endpoints of its organization only, once', async () => {
    const subscribed = (await endpoint('A', ['contact.created'])).endpoint;
    const other = (await endpoint('A', ['deal.won'])).endpoint;
    const elsewhere = (await endpoint('B', ['contact.created'])).endpoint;
    const event = contactCreated(A());
    await createDeliveriesForEvent(services, event);
    await createDeliveriesForEvent(services, event);
    const rows = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event.id)),
    );
    expect(rows.map((row) => row.endpointId)).toContain(subscribed.id);
    expect(rows.some((row) => row.endpointId === other.id)).toBe(false);
    expect(rows.some((row) => row.endpointId === elsewhere.id)).toBe(false);
    expect(new Set(rows.map((row) => row.endpointId)).size).toBe(rows.length);
    // Queued with deterministic ids (the queue drops the duplicate).
    const mine = queued.filter((job) => rows.some((row) => row.id === job.deliveryId));
    expect(new Set(mine.map((job) => job.jobId)).size).toBe(rows.length);
    expect(mine[0]?.attempt).toBe(1);
  });

  it('sends nothing for organizations whose plan lacks the API', async () => {
    await endpoint('B', ['contact.created']);
    expect(await createDeliveriesForEvent(services, contactCreated(B()))).toBe(0);
  });

  it('delivers the exact signed body and records success', async () => {
    const { endpoint: created, secret } = await endpoint('A', ['contact.created']);
    const event = contactCreated(A());
    await createDeliveriesForEvent(services, event);
    const [delivery] = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, created.id))
        .limit(1),
    );
    if (!delivery) throw new Error('missing delivery');
    expect(
      await attemptDelivery(services, { organizationId: A(), deliveryId: delivery.id, attempt: 1 }),
    ).toBe('succeeded');
    const request = received.at(-1);
    expect(request?.body).toBe(delivery.body);
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      id: event.id,
      type: 'contact.created',
      organizationId: A(),
      data: event.payload,
    });
    expect(request?.headers['businessos-event-id']).toBe(event.id);
    expect(request?.headers['user-agent']).toBe('BusinessOS-Webhooks/1');
    expect(
      verifyWebhookSignature({
        body: request?.body ?? '',
        header: request?.headers['businessos-signature'] as string,
        secret,
      }),
    ).toBe(true);
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      responseStatus: 204,
    });
    // A duplicate job for the same attempt does nothing.
    expect(
      await attemptDelivery(services, { organizationId: A(), deliveryId: delivery.id, attempt: 1 }),
    ).toBe('skipped');
    expect(received).toHaveLength(1);
  });

  it('retries failures on a schedule, then fails and counts against the endpoint', async () => {
    const { endpoint: created } = await endpoint('A', ['contact.created']);
    await createDeliveriesForEvent(services, contactCreated(A()));
    const [delivery] = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, created.id)),
    );
    if (!delivery) throw new Error('missing delivery');
    answer = 500;
    const job = { organizationId: A(), deliveryId: delivery.id };
    expect(await attemptDelivery(services, { ...job, attempt: 1 })).toBe('retrying');
    expect(queued.at(-1)).toMatchObject({ attempt: 2, delayMs: RETRY_DELAYS_MS[0] });
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      responseStatus: 500,
      lastError: 'The endpoint answered 500',
    });
    // A stale job for an attempt already made does nothing.
    expect(await attemptDelivery(services, { ...job, attempt: 1 })).toBe('skipped');
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect(await attemptDelivery(services, { ...job, attempt })).toBe('retrying');
    }
    expect(await attemptDelivery(services, { ...job, attempt: MAX_ATTEMPTS })).toBe('failed');
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
    });
    expect((await endpointRow(created.id))?.consecutiveFailures).toBe(1);

    // Redelivery after fixing the receiver.
    answer = 200;
    const { attempt } = await asOwner('A', (tx) =>
      prepareRedelivery(tx, A(), created.id, delivery.id),
    );
    expect(await attemptDelivery(services, { ...job, attempt })).toBe('succeeded');
    expect((await endpointRow(created.id))?.consecutiveFailures).toBe(0);
  });

  it('turns off endpoints that are gone or keep failing', async () => {
    const gone = (await endpoint('A', ['contact.created'])).endpoint;
    await createDeliveriesForEvent(services, contactCreated(A()));
    const [first] = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, gone.id)),
    );
    answer = 410;
    expect(
      await attemptDelivery(services, {
        organizationId: A(),
        deliveryId: first?.id ?? '',
        attempt: 1,
      }),
    ).toBe('failed');
    expect(await endpointRow(gone.id)).toMatchObject({
      status: 'disabled',
      disabledReason: 'failing',
    });

    const failing = (await endpoint('A', ['deal.won'])).endpoint;
    await withSystem(handle.db, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({ consecutiveFailures: DISABLE_AFTER_FAILED_DELIVERIES - 1 })
        .where(eq(webhookEndpoints.id, failing.id)),
    );
    answer = 500;
    const won: DomainEvent = { ...contactCreated(A()), type: 'deal.won' };
    await createDeliveriesForEvent(services, won);
    const [last] = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, failing.id)),
    );
    await withSystem(handle.db, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ attempts: MAX_ATTEMPTS - 1 })
        .where(eq(webhookDeliveries.id, last?.id ?? '')),
    );
    expect(
      await attemptDelivery(services, {
        organizationId: A(),
        deliveryId: last?.id ?? '',
        attempt: MAX_ATTEMPTS,
      }),
    ).toBe('failed');
    expect((await endpointRow(failing.id))?.status).toBe('disabled');
    // Disabled endpoints receive nothing further.
    const next = { ...won, id: newId() };
    await createDeliveriesForEvent(services, next);
    const toDisabled = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, next.id)),
    );
    expect(toDisabled.some((row) => row.endpointId === failing.id)).toBe(false);
  });

  it('refuses private destinations at send time without retrying', async () => {
    const strict: WebhookServices = {
      ...services,
      allowPrivateNetwork: false,
      // The name resolves to a private address (DNS rebinding).
      resolver: (_name, callback) => callback(null, [{ address: '10.0.0.7', family: 4 }]),
    };
    const { endpoint: created } = await endpoint('A', ['contact.created']);
    await withSystem(handle.db, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({ url: 'https://hooks.example.com/rebind' })
        .where(eq(webhookEndpoints.id, created.id)),
    );
    await createDeliveriesForEvent(strict, contactCreated(A()));
    const [delivery] = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, created.id)),
    );
    expect(
      await attemptDelivery(strict, {
        organizationId: A(),
        deliveryId: delivery?.id ?? '',
        attempt: 1,
      }),
    ).toBe('failed');
    expect(received).toHaveLength(0);
  });

  it('sends test events once and lists deliveries privately', async () => {
    const { endpoint: created } = await endpoint('A', ['deal.won']);
    const test = await asOwner('A', (tx) => createTestDelivery(tx, A(), created.id));
    answer = 503;
    expect(
      await attemptDelivery(services, { organizationId: A(), deliveryId: test.id, attempt: 1 }),
    ).toBe('failed');
    expect((await endpointRow(created.id))?.consecutiveFailures).toBe(0);
    const page = await asOwner('A', (tx) => listDeliveries(tx, A(), created.id, {}));
    expect(page.data.map((entry) => entry.id)).toEqual([test.id]);
    const detail = await asOwner('A', (tx) => getDelivery(tx, A(), created.id, test.id));
    expect(JSON.parse(detail.body)).toMatchObject({ type: 'webhook.test' });
    await expect(
      asOwner('B', (tx) => getDelivery(tx, A(), created.id, test.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    const empty = await asOwner('B', (tx) => listDeliveries(tx, A(), created.id, {}));
    expect(empty.data).toEqual([]);
  });

  it('re-queues lost attempts and prunes old deliveries', async () => {
    const { endpoint: created } = await endpoint('A', ['contact.created']);
    await createDeliveriesForEvent(services, contactCreated(A()));
    const [delivery] = await withSystem(handle.db, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, created.id)),
    );
    if (!delivery) throw new Error('missing delivery');
    queued = [];
    const later = new Date(Date.now() + 20 * 60_000);
    const result = await runWebhookMaintenance(services, later);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(queued.find((job) => job.deliveryId === delivery.id)).toMatchObject({ attempt: 1 });
    const muchLater = new Date(Date.now() + 31 * 86_400_000);
    await runWebhookMaintenance(services, muchLater);
    expect(await deliveryRow(delivery.id)).toBeUndefined();
  });
});
