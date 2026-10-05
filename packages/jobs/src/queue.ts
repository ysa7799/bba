import { ValidationError } from '@businessos/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  BACKOFF,
  JOBS,
  type EnqueueOptions,
  type JobMeta,
  type JobName,
  type JobPayload,
  type QueueName,
} from './definitions';

export interface JobQueue {
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: EnqueueOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface JobEnvelope<P = unknown> {
  payload: P;
  meta: JobMeta;
}

const JOB_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

function validate<N extends JobName>(name: N, payload: JobPayload<N>): JobPayload<N> {
  const result = JOBS[name].schema.safeParse(payload);
  if (!result.success) {
    throw new ValidationError(`Invalid payload for job ${name}`);
  }
  return result.data as JobPayload<N>;
}

/** BullMQ-backed queue (production). */
export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly connection: Redis,
    private readonly prefix: string,
    private readonly options: { backoffDelayMs?: number } = {},
  ) {}

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: {
          backoff: { ...BACKOFF, delay: this.options.backoffDelayMs ?? BACKOFF.delay },
          removeOnComplete: { age: 24 * 3600, count: 5_000 },
          // Failed jobs are retained for inspection; exhausted ones are also recorded in Postgres.
          removeOnFail: { age: 14 * 24 * 3600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: EnqueueOptions = {},
  ): Promise<void> {
    const definition = JOBS[name];
    if (options.jobId !== undefined && !JOB_ID_PATTERN.test(options.jobId)) {
      throw new ValidationError('Invalid job id');
    }
    const envelope: JobEnvelope = {
      payload: validate(name, payload),
      meta: { correlationId: options.correlationId, organizationId: options.organizationId },
    };
    await this.queue(definition.queue).add(name, envelope, {
      attempts: definition.attempts,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

export interface RecordedJob<N extends JobName = JobName> {
  name: N;
  payload: JobPayload<N>;
  options: EnqueueOptions;
}

/** In-memory queue for tests; honours deterministic job ids like BullMQ does. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: RecordedJob[] = [];
  private readonly ids = new Set<string>();

  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options: EnqueueOptions = {},
  ): Promise<void> {
    try {
      const validated = validate(name, payload);
      if (options.jobId !== undefined) {
        if (this.ids.has(options.jobId)) return Promise.resolve();
        this.ids.add(options.jobId);
      }
      this.jobs.push({ name, payload: validated, options });
      return Promise.resolve();
    } catch (error) {
      // Same contract as BullJobQueue: invalid payloads reject rather than throw synchronously.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  ofType<N extends JobName>(name: N): RecordedJob<N>[] {
    return this.jobs.filter((job): job is RecordedJob<N> => job.name === name);
  }

  clear(): void {
    this.jobs.length = 0;
    this.ids.clear();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
