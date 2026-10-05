import { crmDeals, crmTasks, type TenantTx } from '@businessos/database';
import type { DomainEvent, EventType } from '@businessos/events';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const optionalId = z.uuid().nullable().default(null);

export const CONTACT_UPDATE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'whatsappPhone',
  'jobTitle',
  'ownerUserId',
  'lifecycleStage',
  'status',
  'customFields',
  'tags',
] as const;

/**
 * Trigger catalogue: the domain event that starts a run (null for inbound webhooks) and the
 * filters staff can set. New modules add their triggers here.
 */
export const TRIGGERS = {
  'contact.created': { event: 'contact.created', config: z.object({}) },
  'contact.updated': {
    event: 'contact.updated',
    config: z.object({
      /** Only when one of these changed (empty: any change). */
      fields: z.array(z.enum(CONTACT_UPDATE_FIELDS)).max(20).default([]),
    }),
  },
  'contact.tag_added': { event: 'contact.tag_added', config: z.object({ tagId: z.uuid() }) },
  'form.submitted': { event: 'form.submitted', config: z.object({ formId: optionalId }) },
  'deal.created': { event: 'deal.created', config: z.object({ pipelineId: optionalId }) },
  'deal.stage_changed': {
    event: 'deal.stage_changed',
    config: z.object({ pipelineId: optionalId, toStageId: optionalId }),
  },
  'appointment.booked': {
    event: 'appointment.booked',
    config: z.object({ appointmentTypeId: optionalId }),
  },
  'task.completed': { event: 'task.completed', config: z.object({}) },
  'invoice.created': { event: 'invoice.created', config: z.object({}) },
  'invoice.paid': { event: 'invoice.paid', config: z.object({}) },
  'message.received': {
    event: 'message.received',
    config: z.object({ channel: z.enum(['email', 'whatsapp', 'sms']).nullable().default(null) }),
  },
  'webhook.received': { event: null, config: z.object({}) },
} as const satisfies Record<string, { event: EventType | null; config: z.ZodType }>;

export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

export function isTriggerType(value: string): value is TriggerType {
  return Object.hasOwn(TRIGGERS, value);
}

/** Event types that can start workflows (the automation subscriber listens to these). */
export const TRIGGER_EVENTS: EventType[] = [
  ...new Set(
    Object.values(TRIGGERS).flatMap((trigger): EventType[] =>
      trigger.event === null ? [] : [trigger.event],
    ),
  ),
];

export const triggerInputSchema = z
  .object({ type: z.enum(TRIGGER_TYPES), config: z.record(z.string(), z.unknown()).default({}) })
  .transform((input, ctx): { type: TriggerType; config: Record<string, unknown> } => {
    const parsed = TRIGGERS[input.type].config.safeParse(input.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
      }
      return z.NEVER;
    }
    return { type: input.type, config: parsed.data };
  });
export type TriggerInput = z.input<typeof triggerInputSchema>;

/** Triggers whose event type is `type`. */
export function triggersFor(type: EventType): TriggerType[] {
  return TRIGGER_TYPES.filter((trigger) => TRIGGERS[trigger].event === type);
}

/** Whether an event passes a trigger's filters. */
export function matchesTrigger(
  trigger: TriggerType,
  rawConfig: Record<string, unknown>,
  event: DomainEvent,
): boolean {
  const parsed = TRIGGERS[trigger].config.safeParse(rawConfig);
  if (!parsed.success) return false;
  const config = parsed.data as Record<string, unknown>;
  const payload = event.payload as Record<string, unknown>;
  switch (trigger) {
    case 'contact.updated': {
      const fields = config.fields as string[];
      const changed = payload.changedFields as string[];
      return fields.length === 0 || changed.some((field) => fields.includes(field));
    }
    case 'contact.tag_added':
      return payload.tagId === config.tagId;
    case 'form.submitted':
      return config.formId === null || payload.formId === config.formId;
    case 'deal.created':
      return config.pipelineId === null || payload.pipelineId === config.pipelineId;
    case 'deal.stage_changed':
      return (
        (config.pipelineId === null || payload.pipelineId === config.pipelineId) &&
        (config.toStageId === null || payload.toStageId === config.toStageId)
      );
    case 'appointment.booked':
      return (
        config.appointmentTypeId === null || payload.appointmentTypeId === config.appointmentTypeId
      );
    case 'message.received':
      return config.channel === null || payload.channel === config.channel;
    default:
      return true;
  }
}

/** The contact and deal a run is about (actions and conditions act on them). */
export async function subjectOf(
  tx: TenantTx,
  organizationId: string,
  event: DomainEvent,
): Promise<{ contactId: string | null; dealId: string | null }> {
  const payload = event.payload as Record<string, unknown>;
  const id = (key: string) => (typeof payload[key] === 'string' ? payload[key] : null);
  switch (event.type) {
    case 'deal.created':
    case 'deal.stage_changed': {
      const dealId = id('dealId');
      if (!dealId) return { contactId: null, dealId: null };
      const [deal] = await tx
        .select({ contactId: crmDeals.contactId })
        .from(crmDeals)
        .where(and(eq(crmDeals.id, dealId), eq(crmDeals.organizationId, organizationId)));
      return { contactId: deal?.contactId ?? null, dealId };
    }
    case 'task.completed': {
      const taskId = id('taskId');
      if (!taskId) return { contactId: null, dealId: null };
      const [task] = await tx
        .select({ contactId: crmTasks.contactId, dealId: crmTasks.dealId })
        .from(crmTasks)
        .where(and(eq(crmTasks.id, taskId), eq(crmTasks.organizationId, organizationId)));
      return { contactId: task?.contactId ?? null, dealId: task?.dealId ?? null };
    }
    case 'form.submitted':
      return { contactId: id('contactId'), dealId: id('dealId') };
    default:
      return { contactId: id('contactId'), dealId: null };
  }
}
