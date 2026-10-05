import type { EventActor } from '@businessos/events';

/**
 * Everything a CRM service needs to know about the tenant and the caller. Built by the API from
 * the resolved tenant (never from client input) and by the worker from the stored job.
 */
export interface CrmContext {
  organizationId: string;
  /** ISO country used to interpret national-format phone numbers. */
  countryCode: string;
  /** Default currency for new deals. */
  defaultCurrency: string;
  /** IANA timezone for "today"/"overdue" task filters. */
  timezone: string;
  actor: CrmActor;
  /**
   * Related record types the caller may read. Names of linked records the caller cannot read
   * are withheld (e.g. a task's contact for a user without `crm.contact.read`). Omitted means
   * everything is readable (system jobs).
   */
  canRead?: { contact: boolean; company: boolean; deal: boolean } | undefined;
}

export function canRead(ctx: CrmContext, type: 'contact' | 'company' | 'deal'): boolean {
  return ctx.canRead?.[type] ?? true;
}

export interface CrmActor {
  type: 'user' | 'system' | 'workflow';
  /** Acting user (the import/export requester for worker jobs). */
  userId: string | null;
  /** The workflow whose run is acting (`workflow` actors). */
  workflowId?: string | null | undefined;
  correlationId?: string | null | undefined;
}

export function eventActor(ctx: CrmContext): EventActor {
  return {
    type: ctx.actor.type,
    id: ctx.actor.type === 'workflow' ? (ctx.actor.workflowId ?? null) : ctx.actor.userId,
  };
}

/** Common options for emitting events from a CRM change. */
export function eventMeta(ctx: CrmContext) {
  return {
    organizationId: ctx.organizationId,
    actor: eventActor(ctx),
    correlationId: ctx.actor.correlationId ?? null,
  };
}
