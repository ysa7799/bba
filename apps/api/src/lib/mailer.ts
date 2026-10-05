import type { AuthEmail, AuthMailer } from '@businessos/auth';
import { appendFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiEnv } from '../env';

/**
 * Development-only mailer that writes email summaries (including links) to the server log.
 * Refused in production by env validation.
 */
export class LogMailer implements AuthMailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  send(email: AuthEmail): Promise<void> {
    this.log.info({ email: { ...email } }, `[dev mailer] ${email.kind} → ${email.to}`);
    return Promise.resolve();
  }
}

/** Appends emails as JSON lines to a file (end-to-end tests). Refused in production. */
export class FileMailer implements AuthMailer {
  constructor(private readonly path: string) {}

  async send(email: AuthEmail): Promise<void> {
    await appendFile(
      this.path,
      `${JSON.stringify({ ...email, sentAt: new Date().toISOString() })}\n`,
    );
  }
}

export function createDevMailer(env: ApiEnv, log: FastifyBaseLogger): AuthMailer {
  if (env.MAIL_TRANSPORT === 'file' && env.MAIL_FILE_PATH)
    return new FileMailer(env.MAIL_FILE_PATH);
  return new LogMailer(log);
}
