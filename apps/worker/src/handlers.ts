import type { Database } from '@businessos/database';
import { loadEvent, type SubscriberRegistry } from '@businessos/events';
import { UnrecoverableError, type JobHandlers } from '@businessos/jobs';
import type { Logger } from 'pino';
import { renderEmail } from './email/templates';
import type { EmailTransport } from './email/transports';

export interface HandlerDeps {
  db: Database;
  registry: SubscriberRegistry;
  email: EmailTransport;
  logger: Logger;
}

export function buildHandlers(deps: HandlerDeps): JobHandlers {
  return {
    'system.ping': (payload) =>
      Promise.resolve({ sentAt: payload.sentAt, receivedAt: new Date().toISOString() }),

    'event.deliver': async (payload, context) => {
      const subscriber = deps.registry.get(payload.subscriber);
      if (!subscriber) {
        throw new UnrecoverableError(`Unknown subscriber: ${payload.subscriber}`);
      }
      const event = await loadEvent(deps.db, payload.eventId);
      if (!event) throw new UnrecoverableError(`Event not found: ${payload.eventId}`);
      await subscriber.handle(event, { attempt: context.attempt });
      return { delivered: true };
    },

    'email.send': async (payload, context) => {
      const rendered = renderEmail(payload.template, payload.data);
      await deps.email.send({
        ...rendered,
        to: payload.to,
        template: payload.template,
        link:
          payload.data.link ?? payload.data.resetLink ?? payload.data.forgotPasswordLink ?? null,
      });
      deps.logger.info(
        {
          template: payload.template,
          transport: deps.email.name,
          correlationId: context.meta.correlationId,
        },
        'email sent',
      );
      return { sent: true };
    },
  };
}
