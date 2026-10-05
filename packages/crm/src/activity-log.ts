import {
  deleteLoggedActivity,
  listActivities,
  MANUAL_ACTIVITY_TYPES,
  recordActivity,
  toActivitySummary,
  type ActivityListQuery,
  type ActivitySummary,
  type ActivityType,
} from '@businessos/activities';
import { crmContactCompanies, crmDeals, type TenantTx } from '@businessos/database';
import { emitEvent } from '@businessos/events';
import type { Permission } from '@businessos/permissions';
import { NotFoundError, ValidationError, type Page } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { eventMeta, type CrmContext } from './context';
import { userNames } from './members';
import { optionalText } from './normalize';
import { assertCompanyExists, assertContactExists, assertDealExists } from './records';

export const logActivityInputSchema = z
  .object({
    type: z.enum(MANUAL_ACTIVITY_TYPES as [ActivityType, ...ActivityType[]]),
    summary: z.string().trim().min(1).max(300),
    details: optionalText(5_000),
    direction: z.enum(['inbound', 'outbound']).optional(),
    durationMinutes: z.number().int().min(0).max(1_440).optional(),
    outcome: optionalText(100),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    contactId: z.uuid().optional(),
    companyId: z.uuid().optional(),
    dealId: z.uuid().optional(),
  })
  .refine((input) => input.contactId ?? input.companyId ?? input.dealId, {
    message: 'Attach the activity to a contact, company or deal',
    path: ['contactId'],
  });
export type LogActivityInput = z.input<typeof logActivityInputSchema>;

/**
 * Logs a call, meeting or message that happened outside BusinessOS. Links are verified in the
 * tenant and completed from the record graph (a deal's contact/company, a contact's primary
 * company). Visibility follows the most specific record: deal, then contact, then company.
 */
export async function logActivity(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: LogActivityInput,
): Promise<ActivitySummary> {
  const input = logActivityInputSchema.parse(rawInput);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + 24 * 3_600_000) {
    throw new ValidationError('Invalid date', [
      { path: 'occurredAt', message: 'Cannot be in the future' },
    ]);
  }
  let { contactId, companyId } = input;
  if (input.dealId) {
    await assertDealExists(tx, ctx.organizationId, input.dealId);
    const [deal] = await tx
      .select({ contactId: crmDeals.contactId, companyId: crmDeals.companyId })
      .from(crmDeals)
      .where(eq(crmDeals.id, input.dealId));
    contactId ??= deal?.contactId ?? undefined;
    companyId ??= deal?.companyId ?? undefined;
  }
  if (input.contactId) await assertContactExists(tx, ctx.organizationId, input.contactId);
  if (input.companyId) await assertCompanyExists(tx, ctx.organizationId, input.companyId);
  if (contactId && !companyId) {
    const [link] = await tx
      .select({ companyId: crmContactCompanies.companyId })
      .from(crmContactCompanies)
      .where(
        and(eq(crmContactCompanies.contactId, contactId), eq(crmContactCompanies.isPrimary, true)),
      );
    companyId = link?.companyId;
  }
  const requiredPermission: Permission = input.dealId
    ? 'crm.deal.read'
    : contactId
      ? 'crm.contact.read'
      : 'crm.company.read';
  const metadata: Record<string, unknown> = {};
  if (input.details) metadata.details = input.details;
  if (input.direction) metadata.direction = input.direction;
  if (input.durationMinutes !== undefined) metadata.durationMinutes = input.durationMinutes;
  if (input.outcome) metadata.outcome = input.outcome;
  const row = await recordActivity(tx, {
    organizationId: ctx.organizationId,
    type: input.type,
    occurredAt,
    actor: { type: ctx.actor.type, userId: ctx.actor.userId },
    subject: { type: 'activity', id: input.dealId ?? contactId ?? companyId ?? ctx.organizationId },
    contactId: contactId ?? null,
    companyId: companyId ?? null,
    dealId: input.dealId ?? null,
    summary: input.summary,
    metadata,
    requiredPermission,
  });
  if (!row) throw new Error('activity insert returned no row');
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'activity.logged',
    subject: { type: 'activity', id: row.id },
    payload: { activityId: row.id, type: row.type },
  });
  const names = ctx.actor.userId
    ? await userNames(tx, [ctx.actor.userId])
    : new Map<string, string>();
  return toActivitySummary(row, ctx.actor.userId ? (names.get(ctx.actor.userId) ?? null) : null);
}

export type TimelineRecord = 'contact' | 'company' | 'deal';

/** 404 unless the record is a live record of this tenant (timelines of other tenants never leak). */
async function requireRecord(
  tx: TenantTx,
  organizationId: string,
  kind: TimelineRecord,
  id: string,
) {
  const check =
    kind === 'contact'
      ? assertContactExists
      : kind === 'company'
        ? assertCompanyExists
        : assertDealExists;
  await check(tx, organizationId, id).catch((error: unknown) => {
    throw error instanceof ValidationError
      ? new NotFoundError(kind === 'contact' ? 'Contact' : kind === 'company' ? 'Company' : 'Deal')
      : error;
  });
}

export async function recordTimeline(
  tx: TenantTx,
  ctx: CrmContext,
  kind: TimelineRecord,
  id: string,
  query: ActivityListQuery,
  permissions: ReadonlySet<string>,
): Promise<Page<ActivitySummary>> {
  await requireRecord(tx, ctx.organizationId, kind, id);
  return listActivities(tx, ctx.organizationId, { kind, id }, query, permissions);
}

export async function deleteActivity(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  access: { permissions: ReadonlySet<string>; canModerate: boolean },
) {
  if (ctx.actor.userId === null) throw new NotFoundError('Activity');
  return deleteLoggedActivity(tx, ctx.organizationId, id, { userId: ctx.actor.userId, ...access });
}
