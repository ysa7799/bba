import {
  jobFailures,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import {
  emitEvent,
  OutboxDispatcher,
  processOnce,
  SubscriberRegistry,
  type DomainEvent,
} from '@businessos/events';
import { BullJobQueue, QUEUE_NAMES, UnrecoverableError } from '@businessos/jobs';
import { createCalendarProviders } from '@businessos/calendar';
import { createChannelProviders } from '@businessos/communications';
import { newId, SecretBox } from '@businessos/shared';
import {
  createTestDatabase,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { Queue, QueueEvents } from 'bullmq';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileEmailTransport } from '../src/email/transports';
import { buildHandlers } from '../src/handlers';
import { createWorkerRedis } from '../src/redis';
import { startRuntime, type WorkerRuntime } from '../src/runtime';

const PREFIX = `test-${uniqueSuffix()}`;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
const logger = pino({ level: 'silent' });
const emailFile = path.join(tmpdir(), `bos-email-${uniqueSuffix()}.jsonl`);

let handle: DatabaseHandle;
let world: TestWorld;
let runtime: WorkerRuntime;
let queue: BullJobQueue;
const registry = new SubscriberRegistry();
const redis = createWorkerRedis(REDIS_URL, 'worker-test');
const producerRedis = createWorkerRedis(REDIS_URL, 'worker-test-producer');

// Subscribers record what they saw for this test file's organization only (the shared test
// database may contain events from other suites).
const received = new Map<string, DomainEvent[]>();
const attempts = new Map<string, number>();
function record(name: string, event: DomainEvent) {
  received.set(name, [...(received.get(name) ?? []), event]);
}
function mine(event: DomainEvent) {
  return event.organizationId === world.orgA.organization.id;
}

async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function emitForA(type: 'organization.updated', marker: string): Promise<string> {
  return withTenant(
    handle.db,
    { organizationId: world.orgA.organization.id, userId: world.orgA.users.owner.id },
    (tx) =>
      emitEvent(tx, {
        type,
        organizationId: world.orgA.organization.id,
        subject: { type: 'organization', id: world.orgA.organization.id },
        actor: { type: 'user', id: world.orgA.users.owner.id },
        payload: { changedFields: [marker] },
        correlationId: `req-${marker}`,
      }),
  );
}

function marker(event: DomainEvent): string | undefined {
  return (event.payload as { changedFields?: string[] }).changedFields?.[0];
}

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
  queue = new BullJobQueue(producerRedis, PREFIX, { backoffDelayMs: 10 });

  registry.register({
    name: 'recorder',
    events: ['organization.updated'],
    handle: (event) => {
      if (mine(event)) record('recorder', event);
      return Promise.resolve();
    },
  });
  registry.register({
    name: 'flaky',
    events: ['organization.updated'],
    handle: (event) => {
      if (!mine(event) || marker(event) !== 'flaky') return Promise.resolve();
      const count = (attempts.get(event.id) ?? 0) + 1;
      attempts.set(event.id, count);
      if (count < 3) return Promise.reject(new Error(`transient failure ${count}`));
      record('flaky', event);
      return Promise.resolve();
    },
  });
  registry.register({
    name: 'broken',
    events: ['organization.updated'],
    handle: (event) => {
      if (!mine(event) || marker(event) !== 'broken') return Promise.resolve();
      return Promise.reject(new UnrecoverableError('cannot ever process this'));
    },
  });
  registry.register({
    name: 'exactly-once',
    events: ['organization.updated'],
    handle: async (event) => {
      if (!mine(event)) return;
      await processOnce(handle.db, 'exactly-once', event.id, () => {
        record('exactly-once', event);
        return Promise.resolve();
      });
    },
  });

  runtime = startRuntime({
    db: handle.db,
    redis,
    queue,
    registry,
    handlers: buildHandlers({
      db: handle.db,
      communications: {
        providers: createChannelProviders({ fake: true }),
        secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
        publicApiUrl: 'http://localhost:4000',
      },
      calendar: { providers: createCalendarProviders({ fake: true }), secretBox: null },
      appUrl: 'http://localhost:3000',
      registry,
      email: new FileEmailTransport(emailFile),
      logger,
    }),
    logger,
    prefix: PREFIX,
    concurrency: 4,
    outboxPollMs: 100,
  });
});

afterAll(async () => {
  await runtime.close();
  await queue.close();
  for (const name of QUEUE_NAMES) {
    const q = new Queue(name, { connection: producerRedis, prefix: PREFIX });
    await q.obliterate({ force: true });
    await q.close();
  }
  await redis.quit();
  await producerRedis.quit();
  await handle.close();
  if (existsSync(emailFile)) rmSync(emailFile);
});

describe('transactional outbox', () => {
  it('delivers committed events to subscribers with the full envelope', async () => {
    const id = await emitForA('organization.updated', 'delivered');
    const event = await waitFor(() => received.get('recorder')?.find((e) => e.id === id));
    expect(event).toMatchObject({
      id,
      type: 'organization.updated',
      version: 1,
      organizationId: world.orgA.organization.id,
      actor: { type: 'user', id: world.orgA.users.owner.id },
      correlationId: 'req-delivered',
      payload: { changedFields: ['delivered'] },
    });
    // Delivery can finish before the dispatcher marks the rest of its batch.
    await waitFor(async () => {
      const [row] = await withSystem(handle.db, (tx) =>
        tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
      );
      return row?.status === 'dispatched';
    });
  });

  it('emits nothing when the business transaction rolls back', async () => {
    const id = newId();
    await expect(
      withTenant(
        handle.db,
        { organizationId: world.orgA.organization.id, userId: null },
        async (tx) => {
          await tx.insert(outboxEvents).values({
            id,
            organizationId: world.orgA.organization.id,
            type: 'organization.updated',
            version: 1,
            subjectType: 'organization',
            subjectId: world.orgA.organization.id,
            actorType: 'system',
            payload: { changedFields: ['rolled-back'] },
          });
          throw new Error('business rule failed');
        },
      ),
    ).rejects.toThrow('business rule failed');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = await withSystem(handle.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
    );
    expect(rows).toEqual([]);
    expect(received.get('recorder')?.some((e) => e.id === id) ?? false).toBe(false);
  });

  it('rejects events whose payload does not match the catalogue', async () => {
    await expect(
      withTenant(handle.db, { organizationId: world.orgA.organization.id, userId: null }, (tx) =>
        emitEvent(tx, {
          type: 'organization.updated',
          organizationId: world.orgA.organization.id,
          subject: { type: 'organization', id: world.orgA.organization.id },
          actor: { type: 'system', id: null },
          payload: { changedFields: 'not-an-array' } as never,
        }),
      ),
    ).rejects.toThrow(/Invalid payload/);
  });

  it('tenant code cannot emit events for another organization', async () => {
    await expect(
      withTenant(handle.db, { organizationId: world.orgA.organization.id, userId: null }, (tx) =>
        emitEvent(tx, {
          type: 'organization.updated',
          organizationId: world.orgB.organization.id,
          subject: { type: 'organization', id: world.orgB.organization.id },
          actor: { type: 'system', id: null },
          payload: { changedFields: [] },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('retries and failures', () => {
  it('retries transient subscriber failures with backoff until they succeed', async () => {
    const id = await emitForA('organization.updated', 'flaky');
    await waitFor(() => received.get('flaky')?.find((e) => e.id === id));
    expect(attempts.get(id)).toBe(3);
  });

  it('dead-letters unrecoverable failures into job_failures without endless retries', async () => {
    const id = await emitForA('organization.updated', 'broken');
    const failure = await waitFor(async () => {
      const rows = await withSystem(handle.db, (tx) =>
        tx
          .select()
          .from(jobFailures)
          .where(eq(jobFailures.jobId, `evt-${id}-broken`)),
      );
      return rows[0];
    });
    expect(failure).toMatchObject({
      queue: 'events',
      jobName: 'event.deliver',
      attempts: 1,
      organizationId: world.orgA.organization.id,
      correlationId: 'req-broken',
    });
    expect(failure.error).toContain('cannot ever process this');
  });

  it('fails invalid payloads permanently and records them', async () => {
    const raw = new Queue('email', { connection: producerRedis, prefix: PREFIX });
    const jobId = `invalid-${uniqueSuffix()}`;
    await raw.add(
      'email.send',
      { payload: { template: 'verify_email', to: 'not-an-email' }, meta: {} },
      { jobId, attempts: 5 },
    );
    await raw.close();
    const failure = await waitFor(async () => {
      const rows = await withSystem(handle.db, (tx) =>
        tx.select().from(jobFailures).where(eq(jobFailures.jobId, jobId)),
      );
      return rows[0];
    });
    expect(failure.attempts).toBe(1);
    expect(failure.error).toContain('Invalid payload');
  });
});

describe('idempotency and concurrency', () => {
  it('delivers each event once per subscriber even when dispatched again', async () => {
    const id = await emitForA('organization.updated', 'redispatch');
    await waitFor(() => received.get('exactly-once')?.find((e) => e.id === id));
    // Simulate a dispatcher that crashed after enqueueing but before marking the row.
    await withSystem(handle.db, (tx) =>
      tx.update(outboxEvents).set({ status: 'pending' }).where(eq(outboxEvents.id, id)),
    );
    await waitFor(async () => {
      const [row] = await withSystem(handle.db, (tx) =>
        tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
      );
      return row?.status === 'dispatched';
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received.get('exactly-once')?.filter((e) => e.id === id)).toHaveLength(1);
    expect(received.get('recorder')?.filter((e) => e.id === id)).toHaveLength(1);
  });

  it('processOnce skips duplicates of the same (subscriber, event)', async () => {
    const eventId = newId();
    let runs = 0;
    const run = () =>
      processOnce(handle.db, 'dedupe-test', eventId, () => {
        runs += 1;
        return Promise.resolve();
      });
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
    expect(runs).toBe(1);
  });

  it('concurrent dispatchers deliver every event exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push(await emitForA('organization.updated', `burst-${i}`));
    const extra = [
      new OutboxDispatcher(handle.db, queue, registry, { batchSize: 7 }),
      new OutboxDispatcher(handle.db, queue, registry, { batchSize: 7 }),
    ];
    await Promise.all(extra.map((dispatcher) => dispatcher.dispatchBatch()));
    await waitFor(() => ids.every((id) => received.get('exactly-once')?.some((e) => e.id === id)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const id of ids) {
      expect(received.get('exactly-once')?.filter((e) => e.id === id)).toHaveLength(1);
      expect(received.get('recorder')?.filter((e) => e.id === id)).toHaveLength(1);
    }
  });

  it('reclaims events whose dispatcher lease expired (crash recovery)', async () => {
    const id = newId();
    await withSystem(handle.db, (tx) =>
      tx.insert(outboxEvents).values({
        id,
        organizationId: world.orgA.organization.id,
        type: 'organization.updated',
        version: 1,
        subjectType: 'organization',
        subjectId: world.orgA.organization.id,
        actorType: 'system',
        payload: { changedFields: ['orphaned'] },
        status: 'processing',
        attempts: 1,
        lockedUntil: new Date(Date.now() - 1_000),
      }),
    );
    await waitFor(() => received.get('recorder')?.find((e) => e.id === id));
  });
});

describe('jobs', () => {
  it('runs a system.ping round trip', async () => {
    const events = new QueueEvents('system', {
      connection: createWorkerRedis(REDIS_URL, 'worker-test-events'),
      prefix: PREFIX,
    });
    await events.waitUntilReady();
    const raw = new Queue('system', { connection: producerRedis, prefix: PREFIX });
    const sentAt = new Date().toISOString();
    const job = await raw.add('system.ping', { payload: { sentAt }, meta: {} });
    const result = (await job.waitUntilFinished(events, 10_000)) as { sentAt: string };
    expect(result.sentAt).toBe(sentAt);
    await raw.close();
    await events.close();
  });

  it('sends queued emails through the configured transport', async () => {
    const to = `mail.${uniqueSuffix()}@example.com`;
    await queue.enqueue('email.send', {
      template: 'verify_email',
      to,
      locale: 'en',
      data: { name: 'Huda', link: 'https://app.example.com/verify-email?token=abc' },
    });
    const line = await waitFor(() => {
      if (!existsSync(emailFile)) return undefined;
      return readFileSync(emailFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as { to: string; link: string; subject: string })
        .find((entry) => entry.to === to);
    });
    expect(line).toMatchObject({
      link: 'https://app.example.com/verify-email?token=abc',
      subject: 'Verify your email address',
    });
  });

  it('rejects invalid payloads at enqueue time', async () => {
    await expect(
      queue.enqueue('email.send', { template: 'x', to: 'nope', locale: 'en', data: {} }),
    ).rejects.toThrow(/Invalid payload/);
  });
});
