import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface PingPayload {
  sentAt: string;
}

export interface PingResult {
  receivedAt: string;
  sentAt: string;
}

/** Round-trip health job used by readiness checks and tests. */
export function processSystemJob(logger: Logger) {
  return (job: Job<PingPayload>): Promise<PingResult> => {
    if (job.name !== 'system.ping') {
      // Unknown jobs fail loudly rather than being silently dropped.
      throw new Error(`Unknown system job: ${job.name}`);
    }
    logger.debug({ jobId: job.id }, 'system.ping');
    return Promise.resolve({ receivedAt: new Date().toISOString(), sentAt: job.data.sentAt });
  };
}
