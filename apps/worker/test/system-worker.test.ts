import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerEnv } from '../src/env';
import { DEFAULT_JOB_OPTIONS, QUEUES } from '../src/queues';
import { createWorkerRedis } from '../src/redis';
import { startWorkers, type WorkerRuntime } from '../src/worker';

const env = loadWorkerEnv({ ...process.env, QUEUE_PREFIX: `test-${process.pid}` });
const redis = createWorkerRedis(env.REDIS_URL, 'worker-test');
const queueRedis = createWorkerRedis(env.REDIS_URL, 'worker-test-queue');
const logger = pino({ level: 'silent' });
let runtime: WorkerRuntime;
let queue: Queue;
let events: QueueEvents;

beforeAll(async () => {
  runtime = startWorkers({ env, redis, logger });
  queue = new Queue(QUEUES.system, { connection: queueRedis, prefix: env.QUEUE_PREFIX });
  events = new QueueEvents(QUEUES.system, {
    connection: createWorkerRedis(env.REDIS_URL, 'worker-test-events'),
    prefix: env.QUEUE_PREFIX,
  });
  await events.waitUntilReady();
});

afterAll(async () => {
  await runtime.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await events.close();
  await redis.quit();
  await queueRedis.quit();
});

describe('worker', () => {
  it('processes a system.ping job round trip', async () => {
    const sentAt = new Date().toISOString();
    const job = await queue.add('system.ping', { sentAt }, DEFAULT_JOB_OPTIONS);
    const result = (await job.waitUntilFinished(events, 10_000)) as { sentAt: string };
    expect(result.sentAt).toBe(sentAt);
  });

  it('fails unknown jobs visibly instead of dropping them', async () => {
    const job = await queue.add('system.unknown', { sentAt: 'x' }, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/Unknown system job/);
    const failed = await queue.getJob(job.id ?? '');
    expect(await failed?.getState()).toBe('failed');
  });
});
