import { deliverMessage, type CommunicationsServices } from '@businessos/communications';
import { processExport, processImport, runCrmMaintenance } from '@businessos/crm';
import type { Database } from '@businessos/database';
import { loadEvent, type SubscriberRegistry } from '@businessos/events';
import { JOBS, UnrecoverableError, type JobHandlers } from '@businessos/jobs';
import { runSubscriptionMaintenance } from '@businessos/payments';
import type { Logger } from 'pino';
import { renderEmail } from './email/templates';
import type { EmailTransport } from './email/transports';

export interface HandlerDeps {
  db: Database;
  communications: CommunicationsServices;
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

    'billing.maintenance': async () => {
      const result = await runSubscriptionMaintenance(deps.db);
      deps.logger.info(result, 'subscription maintenance completed');
      return result;
    },

    'communications.send': async (payload, context) => {
      const outcome = await deliverMessage(
        deps.db,
        deps.communications,
        payload.organizationId,
        payload.messageId,
        {
          finalAttempt: context.attempt >= JOBS['communications.send'].attempts,
        },
      );
      deps.logger.info(
        { messageId: payload.messageId, outcome, attempt: context.attempt },
        'message delivery',
      );
      return { outcome };
    },

    'crm.import': async (payload) => {
      const result = await processImport(deps.db, payload.organizationId, payload.importId);
      deps.logger.info({ importId: payload.importId, result }, 'crm import processed');
      return { result };
    },

    'crm.export': async (payload) => {
      const result = await processExport(deps.db, payload.organizationId, payload.exportId);
      deps.logger.info({ exportId: payload.exportId, result }, 'crm export processed');
      return { result };
    },

    'crm.maintenance': async () => {
      const result = await runCrmMaintenance(deps.db);
      deps.logger.info(result, 'crm maintenance completed');
      return result;
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
