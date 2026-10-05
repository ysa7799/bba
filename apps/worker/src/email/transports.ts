import { MessagingProviderError, PostmarkEmailProvider } from '@businessos/communications';
import { UnrecoverableError } from '@businessos/jobs';
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

/**
 * Production transactional email through Postmark. Retryable provider failures rethrow so the
 * `email.send` job retries; permanent ones are unrecoverable (dead-lettered, never retried).
 */
export class PostmarkEmailTransport implements EmailTransport {
  readonly name = 'postmark';
  private readonly provider: PostmarkEmailProvider;

  constructor(
    private readonly serverToken: string,
    private readonly from: string,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.provider = new PostmarkEmailProvider(options);
  }

  async send(email: OutgoingEmail): Promise<void> {
    try {
      await this.provider.send(
        {
          id: 'platform',
          organizationId: 'platform',
          channel: 'email',
          address: this.from,
          externalAccountId: null,
          credentials: { serverToken: this.serverToken },
          settings: { messageStream: 'outbound' },
          webhookUrl: null,
        },
        {
          id: email.template,
          to: email.to,
          from: this.from,
          subject: email.subject,
          text: email.text,
        },
      );
    } catch (error) {
      if (error instanceof MessagingProviderError && !error.retryable) {
        throw new UnrecoverableError(
          `Email rejected by Postmark (${error.providerCode ?? 'unknown'})`,
        );
      }
      throw error;
    }
  }
}

export function createEmailTransport(env: WorkerEnv, logger: Logger): EmailTransport {
  if (env.EMAIL_TRANSPORT === 'postmark' && env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM) {
    return new PostmarkEmailTransport(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM);
  }
  if (env.EMAIL_TRANSPORT === 'file' && env.EMAIL_FILE_PATH) {
    return new FileEmailTransport(env.EMAIL_FILE_PATH);
  }
  return new LogEmailTransport(logger);
}
