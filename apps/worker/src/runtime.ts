import { jobFailures, withSystem, type Database } from '@businessos/database';
import { OutboxDispatcher, type SubscriberRegistry } from '@businessos/events';
import {
  createProcessor,
  isFinalFailure,
  QUEUE_NAMES,
  type JobEnvelope,
  type JobHandlers,
  type JobQueue,
} from '@businessos/jobs';
import { redactSensitive } from '@businessos/shared';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface RuntimeDeps {
  db: Database;
  /** Connection for BullMQ workers (maxRetriesPerRequest: null). */
  redis: Redis;
  queue: JobQueue;
  registry: SubscriberRegistry;
  handlers: JobHandlers;
  logger: Logger;
  prefix: string;
  concurrency: number;
  outboxPollMs: number;
}

export interface WorkerRuntime {
  workers: Worker[];
  dispatcher: OutboxDispatcher;
  close: () => Promise<void>;
}

/** Persists exhausted/unrecoverable jobs so failures stay visible even if Redis is flushed. */
async function recordFailure(db: Database, queue: string, job: Job<JobEnvelope>, error: Error) {
  const payload = job.data.payload;
  // System scope: dead-letter bookkeeping spans tenants.
  await withSystem(db, (tx) =>
    tx.insert(jobFailures).values({
      queue,
      jobName: job.name,
      jobId: job.id ?? null,
      organizationId: job.data.meta.organizationId ?? null,
      correlationId: job.data.meta.correlationId ?? null,
      attempts: job.attemptsMade,
      error: error.message.slice(0, 2_000),
      payload:
        payload !== null && typeof payload === 'object'
          ? (redactSensitive(payload) as Record<string, unknown>)
          : {},
    }),
  );
}

export function startRuntime(deps: RuntimeDeps): WorkerRuntime {
  const processor = createProcessor(deps.handlers);
  const workers = QUEUE_NAMES.map((queue) => {
    const worker = new Worker<JobEnvelope>(queue, processor, {
      connection: deps.redis,
      prefix: deps.prefix,
      concurrency: deps.concurrency,
    });
    worker.on('failed', (job, error) => {
      if (!job) return;
      const final = isFinalFailure(job, error);
      deps.logger.error(
        {
          queue,
          jobId: job.id,
          jobName: job.name,
          attempt: job.attemptsMade,
          final,
          correlationId: job.data.meta.correlationId,
          err: error,
        },
        final ? 'job failed permanently' : 'job failed; will retry',
      );
      if (final) {
        recordFailure(deps.db, queue, job, error).catch((recordError: unknown) => {
          deps.logger.error({ err: recordError, jobId: job.id }, 'could not record job failure');
        });
      }
    });
    worker.on('error', (error) => {
      deps.logger.error({ queue, err: error }, 'worker error');
    });
    return worker;
  });

  const dispatcher = new OutboxDispatcher(deps.db, deps.queue, deps.registry, {
    logger: deps.logger,
  });
  const stopDispatcher = dispatcher.start(deps.outboxPollMs);

  return {
    workers,
    dispatcher,
    close: async () => {
      await stopDispatcher();
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
