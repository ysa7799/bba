import type { AuthEmail, AuthMailer } from '@businessos/auth';
import type { JobPayload, JobQueue } from '@businessos/jobs';

/** Converts an auth email into the `email.send` job payload (template + string data). */
export function toEmailJob(email: AuthEmail): JobPayload<'email.send'> {
  const { kind, to, locale, ...rest } = email;
  const data: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(rest)) {
    data[key] = value;
  }
  return { template: kind, to, locale, data };
}

/**
 * Sends auth emails through the job queue: delivery happens in the worker with retries and
 * dead-letter visibility. Enqueueing happens after the auth transaction committed.
 */
export class QueueMailer implements AuthMailer {
  constructor(
    private readonly jobs: JobQueue,
    private readonly correlationId?: string,
  ) {}

  async send(email: AuthEmail): Promise<void> {
    await this.jobs.enqueue('email.send', toEmailJob(email), {
      correlationId: this.correlationId,
    });
  }
}
