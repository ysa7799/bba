import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { createProcessor, isFinalFailure, UnrecoverableError } from './processor';
import { MemoryJobQueue, type JobEnvelope } from './queue';

function fakeJob(name: string, payload: unknown, attemptsMade = 0, attempts = 3): Job<JobEnvelope> {
  return {
    name,
    id: 'job-1',
    attemptsMade,
    opts: { attempts },
    data: { payload, meta: { correlationId: 'req-1' } },
  } as unknown as Job<JobEnvelope>;
}

describe('MemoryJobQueue', () => {
  it('validates payloads on enqueue', async () => {
    const queue = new MemoryJobQueue();
    await expect(
      queue.enqueue('email.send', { template: 'verify_email', to: 'bad', locale: 'en', data: {} }),
    ).rejects.toThrow(/Invalid payload/);
    expect(queue.jobs).toHaveLength(0);
  });

  it('deduplicates deterministic job ids', async () => {
    const queue = new MemoryJobQueue();
    const payload = { eventId: '01a10a7d-64ba-7000-a694-68839952f9b9', subscriber: 'x' };
    await queue.enqueue('event.deliver', payload, { jobId: 'evt-1-x' });
    await queue.enqueue('event.deliver', payload, { jobId: 'evt-1-x' });
    await queue.enqueue('event.deliver', payload, { jobId: 'evt-1-y' });
    expect(queue.ofType('event.deliver')).toHaveLength(2);
  });
});

describe('createProcessor', () => {
  it('runs the handler with parsed payload and context', async () => {
    const processor = createProcessor({
      'system.ping': (payload, context) => Promise.resolve({ payload, context }),
    });
    const result = await processor(fakeJob('system.ping', { sentAt: 'now', extra: 'stripped' }));
    expect(result).toEqual({
      payload: { sentAt: 'now' },
      context: { jobId: 'job-1', attempt: 1, meta: { correlationId: 'req-1' } },
    });
  });

  it('fails unknown jobs, missing handlers and invalid payloads permanently', async () => {
    const processor = createProcessor({ 'system.ping': () => Promise.resolve(null) });
    await expect(processor(fakeJob('drop.everything', {}))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(processor(fakeJob('email.send', {}))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor(fakeJob('system.ping', { sentAt: 42 }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('isFinalFailure', () => {
  it('is final for unrecoverable errors or exhausted attempts only', () => {
    expect(isFinalFailure(fakeJob('system.ping', {}, 1, 3), new Error('x'))).toBe(false);
    expect(isFinalFailure(fakeJob('system.ping', {}, 3, 3), new Error('x'))).toBe(true);
    expect(isFinalFailure(fakeJob('system.ping', {}, 1, 3), new UnrecoverableError('x'))).toBe(
      true,
    );
  });
});
