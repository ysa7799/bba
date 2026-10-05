import { UnrecoverableError, type Job } from 'bullmq';
import { isJobName, JOBS, type JobMeta, type JobName, type JobPayload } from './definitions';
import type { JobEnvelope } from './queue';

export interface JobContext {
  jobId: string | undefined;
  attempt: number;
  meta: JobMeta;
}

export type JobHandler<N extends JobName> = (
  payload: JobPayload<N>,
  context: JobContext,
) => Promise<unknown>;

export type JobHandlers = { [N in JobName]?: JobHandler<N> };

/**
 * Builds a BullMQ processor that validates payloads before running handlers. Unknown jobs and
 * invalid payloads fail permanently (UnrecoverableError) instead of retrying forever.
 */
export function createProcessor(handlers: JobHandlers) {
  return async (job: Job<JobEnvelope>): Promise<unknown> => {
    if (!isJobName(job.name)) {
      throw new UnrecoverableError(`Unknown job: ${job.name}`);
    }
    // The registry guarantees handler and schema agree on the payload type for `job.name`.
    const handler = handlers[job.name] as
      ((payload: unknown, context: JobContext) => Promise<unknown>) | undefined;
    if (!handler) {
      throw new UnrecoverableError(`No handler registered for job: ${job.name}`);
    }
    const parsed = JOBS[job.name].schema.safeParse(job.data.payload);
    if (!parsed.success) {
      throw new UnrecoverableError(`Invalid payload for job: ${job.name}`);
    }
    return handler(parsed.data, {
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      meta: job.data.meta,
    });
  };
}

/** True when a failed job will not be retried again (dead-letter it). */
export function isFinalFailure(job: Job, error: Error): boolean {
  if (error instanceof UnrecoverableError || error.name === 'UnrecoverableError') return true;
  const attempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= attempts;
}

export { UnrecoverableError };
