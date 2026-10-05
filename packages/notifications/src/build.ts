import {
  appointments,
  automationWorkflows,
  calendars,
  commerceInvoices,
  commerceQuotes,
  conversations,
  crmDeals,
  crmTasks,
  type TenantTx,
} from '@businessos/database';
import type { DomainEvent, EventPayload } from '@businessos/events';
import { formatDecimal, isCurrencyCode, money } from '@businessos/shared';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { NotificationType } from './catalogue';

/** A notification to deliver to some members (each is checked before delivery). */
export interface NotificationDraft {
  type: NotificationType;
  recipients: string[];
  title: string;
  body: string | null;
  /** In-app path below `/o/<organizationId>/`. */
  path: string;
  subject: { type: string; id: string };
}

function amount(minor: bigint | string | null, currency: string): string | null {
  if (minor === null || !isCurrencyCode(currency)) return null;
  return `${currency} ${formatDecimal(money(BigInt(minor), currency))}`;
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Builder = (tx: TenantTx, event: DomainEvent) => Promise<NotificationDraft[]>;

const taskAssigned: Builder = async (tx, event) => {
  const payload = event.payload as EventPayload<'task.created'>;
  if (!payload.assigneeUserId) return [];
  const [task] = await tx
    .select({ id: crmTasks.id, title: crmTasks.title, dueAt: crmTasks.dueAt })
    .from(crmTasks)
    .where(
      and(eq(crmTasks.id, payload.taskId), eq(crmTasks.organizationId, event.organizationId ?? '')),
    );
  if (!task) return [];
  return [
    {
      type: 'task.assigned',
      recipients: [payload.assigneeUserId],
      title: clip(`Task assigned to you: ${task.title}`),
      body: null,
      path: 'crm/tasks',
      subject: { type: 'task', id: task.id },
    },
  ];
};

const conversationAssigned: Builder = async (tx, event) => {
  const payload = event.payload as EventPayload<'conversation.assigned'>;
  if (!payload.assigneeUserId) return [];
  const [conversation] = await tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      name: conversations.counterpartName,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, payload.conversationId),
        eq(conversations.organizationId, event.organizationId ?? ''),
      ),
    );
  if (!conversation) return [];
  return [
    {
      type: 'conversation.assigned',
      recipients: [payload.assigneeUserId],
      title: clip(
        `Conversation assigned to you${conversation.name ? `: ${conversation.name}` : ''}`,
      ),
      body: `Channel: ${conversation.channel}`,
      path: `inbox?c=${conversation.id}`,
      subject: { type: 'conversation', id: conversation.id },
    },
  ];
};

const dealWon: Builder = async (tx, event) => {
  const payload = event.payload as EventPayload<'deal.won'>;
  const [deal] = await tx
    .select({ id: crmDeals.id, name: crmDeals.name, ownerUserId: crmDeals.ownerUserId })
    .from(crmDeals)
    .where(
      and(eq(crmDeals.id, payload.dealId), eq(crmDeals.organizationId, event.organizationId ?? '')),
    );
  if (!deal?.ownerUserId) return [];
  return [
    {
      type: 'deal.won',
      recipients: [deal.ownerUserId],
      title: clip(`Deal won: ${deal.name}`),
      body: amount(payload.valueMinor, payload.currency),
      path: `crm/deals/${deal.id}`,
      subject: { type: 'deal', id: deal.id },
    },
  ];
};

const appointmentBooked: Builder = async (tx, event) => {
  const payload = event.payload as EventPayload<'appointment.booked'>;
  const organizationId = event.organizationId ?? '';
  const [appointment] = await tx
    .select({
      id: appointments.id,
      title: appointments.title,
      startsAt: appointments.startsAt,
      timezone: appointments.timezone,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, payload.appointmentId),
        eq(appointments.organizationId, organizationId),
      ),
    );
  if (!appointment) return [];
  const hosts = await tx
    .select({ userId: calendars.userId })
    .from(calendars)
    .where(
      and(
        eq(calendars.organizationId, organizationId),
        inArray(calendars.id, payload.calendarIds),
        isNotNull(calendars.userId),
      ),
    );
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: appointment.timezone,
  }).format(appointment.startsAt);
  return [
    {
      type: 'appointment.booked',
      recipients: hosts.map((host) => host.userId).filter((id): id is string => id !== null),
      title: clip(`New booking: ${appointment.title}`),
      body: `${when} (${appointment.timezone})`,
      path: 'calendar',
      subject: { type: 'appointment', id: appointment.id },
    },
  ];
};

function quoteAnswered(type: 'quote.accepted' | 'quote.declined', verb: string): Builder {
  return async (tx, event) => {
    const payload = event.payload as EventPayload<'quote.accepted'>;
    const [quote] = await tx
      .select({
        id: commerceQuotes.id,
        number: commerceQuotes.number,
        createdByUserId: commerceQuotes.createdByUserId,
      })
      .from(commerceQuotes)
      .where(
        and(
          eq(commerceQuotes.id, payload.quoteId),
          eq(commerceQuotes.organizationId, event.organizationId ?? ''),
        ),
      );
    if (!quote?.createdByUserId) return [];
    return [
      {
        type,
        recipients: [quote.createdByUserId],
        title: `Quote ${quote.number} ${verb}`,
        body: payload.by === 'customer' ? 'Answered by the customer' : 'Recorded by a teammate',
        path: `commerce/quotes/${quote.id}`,
        subject: { type: 'quote', id: quote.id },
      },
    ];
  };
}

function invoiceUpdate(type: 'invoice.paid' | 'invoice.overdue', verb: string): Builder {
  return async (tx, event) => {
    const payload = event.payload as EventPayload<'invoice.overdue'>;
    const [invoice] = await tx
      .select({
        id: commerceInvoices.id,
        number: commerceInvoices.number,
        createdByUserId: commerceInvoices.createdByUserId,
        totalMinor: commerceInvoices.totalMinor,
        currency: commerceInvoices.currency,
      })
      .from(commerceInvoices)
      .where(
        and(
          eq(commerceInvoices.id, payload.invoiceId),
          eq(commerceInvoices.organizationId, event.organizationId ?? ''),
        ),
      );
    if (!invoice?.createdByUserId || !invoice.number) return [];
    return [
      {
        type,
        recipients: [invoice.createdByUserId],
        title: `Invoice ${invoice.number} ${verb}`,
        body: amount(invoice.totalMinor, invoice.currency),
        path: `commerce/invoices/${invoice.id}`,
        subject: { type: 'invoice', id: invoice.id },
      },
    ];
  };
}

const workflowFailed: Builder = async (tx, event) => {
  const payload = event.payload as EventPayload<'workflow.failed'>;
  const [workflow] = await tx
    .select({
      id: automationWorkflows.id,
      name: automationWorkflows.name,
      createdByUserId: automationWorkflows.createdByUserId,
    })
    .from(automationWorkflows)
    .where(
      and(
        eq(automationWorkflows.id, payload.workflowId),
        eq(automationWorkflows.organizationId, event.organizationId ?? ''),
      ),
    );
  if (!workflow?.createdByUserId) return [];
  return [
    {
      type: 'workflow.failed',
      recipients: [workflow.createdByUserId],
      title: clip(`Workflow failed: ${workflow.name}`),
      body: clip(payload.error, 300),
      path: `automation/${workflow.id}/runs?run=${payload.runId}`,
      subject: { type: 'workflow_run', id: payload.runId },
    },
  ];
};

export const BUILDERS: Partial<Record<DomainEvent['type'], Builder>> = {
  'task.created': taskAssigned,
  'conversation.assigned': conversationAssigned,
  'deal.won': dealWon,
  'appointment.booked': appointmentBooked,
  'quote.accepted': quoteAnswered('quote.accepted', 'accepted'),
  'quote.declined': quoteAnswered('quote.declined', 'declined'),
  'invoice.paid': invoiceUpdate('invoice.paid', 'paid'),
  'invoice.overdue': invoiceUpdate('invoice.overdue', 'is overdue'),
  'workflow.failed': workflowFailed,
};
