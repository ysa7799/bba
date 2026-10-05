import { outboxEvents, withSystem, withTenant, type DatabaseHandle } from '@businessos/database';
import { MemoryJobQueue, type JobQueue } from '@businessos/jobs';
import { newId } from '@businessos/shared';
import { createTestDatabase, createTestWorld, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryJobId, emitEvent, OutboxDispatcher, SubscriberRegistry } from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase();
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

async function emit(marker: string): Promise<string> {
  return withTenant(handle.db, { organizationId: world.orgA.organization.id, userId: null }, (tx) =>
    emitEvent(tx, {
      type: 'organization.updated',
      organizationId: world.orgA.organization.id,
      subject: { type: 'organization', id: world.orgA.organization.id },
      actor: { type: 'system', id: null },
      payload: { changedFields: [marker] },
    }),
  );
}

async function row(id: string) {
  const [found] = await withSystem(handle.db, (tx) =>
    tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
  );
  return found;
}

/** Dispatches until the given event leaves the pending/processing states (shared test DB). */
async function dispatchUntilSettled(dispatcher: OutboxDispatcher, id: string) {
  for (let i = 0; i < 200; i += 1) {
    await dispatcher.dispatchBatch();
    const current = await row(id);
    if (current && current.status !== 'pending' && current.status !== 'processing') return current;
    if (current?.status === 'pending' && current.lastError) return current;
  }
  throw new Error('event did not settle');
}

describe('OutboxDispatcher', () => {
  it('fans out one deterministic job per subscriber and marks the event dispatched', async () => {
    const queue = new MemoryJobQueue();
    const registry = new SubscriberRegistry()
      .register({ name: 'a', events: ['organization.updated'], handle: () => Promise.resolve() })
      .register({ name: 'b', events: '*', handle: () => Promise.resolve() })
      .register({ name: 'c', events: ['member.joined'], handle: () => Promise.resolve() });
    const id = await emit('fanout');
    const settled = await dispatchUntilSettled(
      new OutboxDispatcher(handle.db, queue, registry),
      id,
    );
    expect(settled.status).toBe('dispatched');
    const jobs = queue.ofType('event.deliver').filter((job) => job.payload.eventId === id);
    expect(jobs.map((job) => job.payload.subscriber).sort()).toEqual(['a', 'b']);
    expect(jobs.map((job) => job.options.jobId).sort()).toEqual([
      deliveryJobId(id, 'a'),
      deliveryJobId(id, 'b'),
    ]);
    expect(jobs[0]?.options.organizationId).toBe(world.orgA.organization.id);
  });

  it('marks events without subscribers as dispatched', async () => {
    const id = await emit('nobody-listens');
    const settled = await dispatchUntilSettled(
      new OutboxDispatcher(handle.db, new MemoryJobQueue(), new SubscriberRegistry()),
      id,
    );
    expect(settled.status).toBe('dispatched');
  });

  it('backs off on enqueue failure and marks the event failed after max attempts', async () => {
    const failing: JobQueue = {
      enqueue: () => Promise.reject(new Error('redis down')),
      close: () => Promise.resolve(),
    };
    const registry = new SubscriberRegistry().register({
      name: 'any',
      events: '*',
      handle: () => Promise.resolve(),
    });
    const dispatcher = new OutboxDispatcher(handle.db, failing, registry, { maxAttempts: 2 });
    const id = await emit('no-redis');

    const first = await dispatchUntilSettled(dispatcher, id);
    expect(first).toMatchObject({ status: 'pending', attempts: 1, lastError: 'redis down' });
    expect(first.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Make it due again and retry: the second failure exhausts the attempts.
    await withSystem(handle.db, (tx) =>
      tx
        .update(outboxEvents)
        .set({ availableAt: new Date(Date.now() - 1) })
        .where(eq(outboxEvents.id, id)),
    );
    const second = await dispatchUntilSettled(dispatcher, id);
    expect(second).toMatchObject({ status: 'failed', attempts: 2, lastError: 'redis down' });
  });

  it('never claims events that are not yet due', async () => {
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
        payload: { changedFields: ['future'] },
        availableAt: new Date(Date.now() + 60_000),
      }),
    );
    const dispatcher = new OutboxDispatcher(
      handle.db,
      new MemoryJobQueue(),
      new SubscriberRegistry(),
    );
    for (let i = 0; i < 5; i += 1) await dispatcher.dispatchBatch();
    expect((await row(id))?.status).toBe('pending');
    expect((await row(id))?.attempts).toBe(0);
  });

  it('rejects invalid subscriber registrations', () => {
    const registry = new SubscriberRegistry();
    expect(() =>
      registry.register({ name: 'Bad Name', events: '*', handle: () => Promise.resolve() }),
    ).toThrow();
    registry.register({ name: 'ok', events: '*', handle: () => Promise.resolve() });
    expect(() =>
      registry.register({ name: 'ok', events: '*', handle: () => Promise.resolve() }),
    ).toThrow(/Duplicate/);
  });
});
