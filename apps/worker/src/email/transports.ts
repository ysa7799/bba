import { appendFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import type { RenderedEmail } from './templates';

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  template: string;
  /** Primary call-to-action link, if any (used by development transports). */
  link: string | null;
}

export interface EmailTransport {
  readonly name: string;
  send(email: OutgoingEmail): Promise<void>;
}

/** Development only: writes the message (including links) to the worker log. */
export class LogEmailTransport implements EmailTransport {
  readonly name = 'log';
  constructor(private readonly logger: Logger) {}

  send(email: OutgoingEmail): Promise<void> {
    this.logger.info({ to: email.to, subject: email.subject, link: email.link }, '[dev email]');
    return Promise.resolve();
  }
}

/** End-to-end tests: appends JSON lines that the test runner reads. */
export class FileEmailTransport implements EmailTransport {
  readonly name = 'file';
  constructor(private readonly path: string) {}

  async send(email: OutgoingEmail): Promise<void> {
    await appendFile(
      this.path,
      `${JSON.stringify({ kind: email.template, to: email.to, link: email.link, subject: email.subject, sentAt: new Date().toISOString() })}\n`,
    );
  }
}

export function createEmailTransport(env: WorkerEnv, logger: Logger): EmailTransport {
  if (env.EMAIL_TRANSPORT === 'file' && env.EMAIL_FILE_PATH) {
    return new FileEmailTransport(env.EMAIL_FILE_PATH);
  }
  return new LogEmailTransport(logger);
}
