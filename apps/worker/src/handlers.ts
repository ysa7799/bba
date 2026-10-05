import { executeRun, resumeDueRuns, type AutomationServices } from '@businessos/automation';
import {
  processDueReminders,
  syncAppointmentEvents,
  type CalendarServices,
} from '@businessos/calendar';
import { expireQuotes, markOverdueInvoices } from '@businessos/commerce';
import { deliverMessage, type CommunicationsServices } from '@businessos/communications';
import { runFilesMaintenance, type FileServices } from '@businessos/files';
import { processExport, processImport, runCrmMaintenance } from '@businessos/crm';
import type { Database } from '@businessos/database';
import { loadEvent, type SubscriberRegistry } from '@businessos/events';
import { JOBS, UnrecoverableError, type JobHandlers } from '@businessos/jobs';
import { pruneNotifications } from '@businessos/notifications';
import { runSubscriptionMaintenance } from '@businessos/payments';
import type { Logger } from 'pino';
import { renderEmail } from './email/templates';
import type { EmailTransport } from './email/transports';

export interface HandlerDeps {
  db: Database;
  communications: CommunicationsServices;
  calendar: CalendarServices;
  automation: AutomationServices;
  files: FileServices;
  /** Public web app URL for links in job-sent emails. */
  appUrl: string;
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

    'files.maintenance': async () => {
      const result = await runFilesMaintenance(deps.files);
      if (result.abandoned > 0 || result.purged > 0) {
        deps.logger.info(result, 'file maintenance completed');
      }
      return result;
    },

    'notifications.maintenance': async () => {
      const removed = await pruneNotifications(deps.db);
      if (removed > 0) deps.logger.info({ removed }, 'notification retention completed');
      return { removed };
    },

    'commerce.maintenance': async () => {
      const overdue = await markOverdueInvoices(deps.db);
      const quotes = await expireQuotes(deps.db);
      const result = { ...overdue, ...quotes };
      if (overdue.overdue > 0 || quotes.expired > 0) {
        deps.logger.info(result, 'commerce maintenance completed');
      }
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

    'calendar.reminders': async () => {
      const result = await processDueReminders(deps.db, {
        now: Date.now(),
        appUrl: deps.appUrl,
        send: async (email) => {
          const rendered = renderEmail('appointment_reminder', email.data);
          await deps.email.send({
            ...rendered,
            to: email.to,
            template: 'appointment_reminder',
            link: email.data.manageUrl,
          });
        },
      });
      if (result.sent + result.failed > 0) deps.logger.info(result, 'appointment reminders');
      return result;
    },

    'calendar.sync': async (payload) => {
      const outcome = await syncAppointmentEvents(
        deps.db,
        deps.calendar,
        payload.organizationId,
        payload.appointmentId,
      );
      deps.logger.info({ appointmentId: payload.appointmentId, outcome }, 'calendar sync');
      return outcome;
    },

    'automation.run': async (payload) => {
      const outcome = await executeRun(
        deps.db,
        deps.automation,
        payload.organizationId,
        payload.runId,
      );
      deps.logger.info({ runId: payload.runId, outcome }, 'workflow run');
      return { outcome };
    },

    'automation.resume': async () => {
      const result = await resumeDueRuns(deps.db, deps.automation);
      if (result.queued > 0) deps.logger.info(result, 'workflow runs resumed');
      return result;
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
          payload.data.link ??
          payload.data.resetLink ??
          payload.data.forgotPasswordLink ??
          payload.data.manageUrl ??
          null,
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
