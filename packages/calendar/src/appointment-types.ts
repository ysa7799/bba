import type { CrmContext } from '@businessos/crm';
import {
  appointmentTypeHosts,
  appointmentTypes,
  calendars,
  type AppointmentType,
  type TenantTx,
} from '@businessos/database';
import { NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SchedulingMode } from './scheduling';

/** Lower-case URL slug from free text (`Site visit – Riffa` → `site-visit-riffa`). */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug;
}

export function randomSlugSuffix(): string {
  return randomBytes(4).toString('hex').slice(0, 6);
}

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, 'Use lower-case letters, digits and dashes');

const typeFields = {
  name: z.string().trim().min(1).max(100),
  slug: slugSchema.optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(720),
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  slotIntervalMinutes: z.number().int().min(5).max(240),
  minimumNoticeMinutes: z.number().int().min(0).max(43_200),
  maximumAdvanceDays: z.number().int().min(1).max(365),
  schedulingMode: z.enum(['individual', 'round_robin', 'collective']),
  locationKind: z.enum(['in_person', 'phone', 'video', 'custom']),
  locationDetails: z.string().trim().max(500).nullable().optional(),
  hostCalendarIds: z.array(z.uuid()).min(1).max(20),
  isActive: z.boolean(),
};

export const createAppointmentTypeInputSchema = z.object({
  ...typeFields,
  bufferBeforeMinutes: typeFields.bufferBeforeMinutes.default(0),
  bufferAfterMinutes: typeFields.bufferAfterMinutes.default(0),
  slotIntervalMinutes: typeFields.slotIntervalMinutes.default(30),
  minimumNoticeMinutes: typeFields.minimumNoticeMinutes.default(60),
  maximumAdvanceDays: typeFields.maximumAdvanceDays.default(60),
  schedulingMode: typeFields.schedulingMode.default('individual'),
  locationKind: typeFields.locationKind.default('in_person'),
  isActive: typeFields.isActive.default(true),
});
export const updateAppointmentTypeInputSchema = z.object(typeFields).partial();

export interface AppointmentTypeSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
  schedulingMode: SchedulingMode;
  locationKind: AppointmentType['locationKind'];
  locationDetails: string | null;
  isActive: boolean;
  hosts: { calendarId: string; name: string }[];
}

function toSummary(
  row: AppointmentType,
  hosts: { calendarId: string; name: string }[],
): AppointmentTypeSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    slotIntervalMinutes: row.slotIntervalMinutes,
    minimumNoticeMinutes: row.minimumNoticeMinutes,
    maximumAdvanceDays: row.maximumAdvanceDays,
    schedulingMode: row.schedulingMode,
    locationKind: row.locationKind,
    locationDetails: row.locationDetails,
    isActive: row.isActive,
    hosts,
  };
}

async function hostsFor(tx: TenantTx, typeIds: readonly string[]) {
  const map = new Map<string, { calendarId: string; name: string }[]>();
  if (typeIds.length === 0) return map;
  const rows = await tx
    .select({
      typeId: appointmentTypeHosts.appointmentTypeId,
      calendarId: calendars.id,
      name: calendars.name,
    })
    .from(appointmentTypeHosts)
    .innerJoin(calendars, eq(calendars.id, appointmentTypeHosts.calendarId))
    .where(inArray(appointmentTypeHosts.appointmentTypeId, [...typeIds]))
    .orderBy(asc(calendars.name), asc(calendars.id));
  for (const row of rows) {
    map.set(row.typeId, [
      ...(map.get(row.typeId) ?? []),
      { calendarId: row.calendarId, name: row.name },
    ]);
  }
  return map;
}

async function validateHosts(
  tx: TenantTx,
  organizationId: string,
  mode: SchedulingMode,
  calendarIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(calendarIds)];
  if (mode === 'individual' && unique.length !== 1) {
    throw new ValidationError('Invalid hosts', [
      { path: 'hostCalendarIds', message: 'One-to-one appointments have exactly one host' },
    ]);
  }
  if (mode !== 'individual' && unique.length < 2) {
    throw new ValidationError('Invalid hosts', [
      { path: 'hostCalendarIds', message: 'Team scheduling needs at least two hosts' },
    ]);
  }
  const rows = await tx
    .select({ id: calendars.id })
    .from(calendars)
    .where(
      and(
        eq(calendars.organizationId, organizationId),
        eq(calendars.isActive, true),
        inArray(calendars.id, unique),
      ),
    );
  if (rows.length !== unique.length) {
    throw new ValidationError('Invalid hosts', [
      { path: 'hostCalendarIds', message: 'Hosts must be active calendars of this organization' },
    ]);
  }
  return unique;
}

async function uniqueSlug(
  tx: TenantTx,
  organizationId: string,
  wanted: string,
  excludeId?: string,
): Promise<string> {
  const base = wanted || 'appointment';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 50)}-${randomSlugSuffix()}`;
    const [taken] = await tx
      .select({ id: appointmentTypes.id })
      .from(appointmentTypes)
      .where(
        and(
          eq(appointmentTypes.organizationId, organizationId),
          eq(appointmentTypes.slug, candidate),
        ),
      );
    if (!taken || taken.id === excludeId) return candidate;
  }
  throw new ValidationError('Slug taken', [{ path: 'slug', message: 'Choose another link name' }]);
}

export async function listAppointmentTypes(
  tx: TenantTx,
  organizationId: string,
  options: { activeOnly?: boolean } = {},
): Promise<AppointmentTypeSummary[]> {
  const rows = await tx
    .select()
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.organizationId, organizationId),
        options.activeOnly ? eq(appointmentTypes.isActive, true) : undefined,
      ),
    )
    .orderBy(asc(appointmentTypes.name), asc(appointmentTypes.id))
    .limit(200);
  const hosts = await hostsFor(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toSummary(row, hosts.get(row.id) ?? []));
}

export async function getAppointmentTypeRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<AppointmentType> {
  const [row] = await tx
    .select()
    .from(appointmentTypes)
    .where(and(eq(appointmentTypes.id, id), eq(appointmentTypes.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Appointment type');
  return row;
}

export async function getAppointmentType(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<AppointmentTypeSummary> {
  const row = await getAppointmentTypeRow(tx, organizationId, id);
  return toSummary(row, (await hostsFor(tx, [id])).get(id) ?? []);
}

/** Host calendar ids of an appointment type. */
export async function hostCalendarIds(tx: TenantTx, typeId: string): Promise<string[]> {
  const rows = await tx
    .select({ calendarId: appointmentTypeHosts.calendarId })
    .from(appointmentTypeHosts)
    .where(eq(appointmentTypeHosts.appointmentTypeId, typeId))
    .orderBy(asc(appointmentTypeHosts.calendarId));
  return rows.map((row) => row.calendarId);
}

export async function createAppointmentType(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createAppointmentTypeInputSchema>,
): Promise<AppointmentTypeSummary> {
  const {
    hostCalendarIds: hostIds,
    slug,
    ...input
  } = createAppointmentTypeInputSchema.parse(rawInput);
  const hosts = await validateHosts(tx, ctx.organizationId, input.schedulingMode, hostIds);
  const [row] = await tx
    .insert(appointmentTypes)
    .values({
      ...input,
      organizationId: ctx.organizationId,
      slug: await uniqueSlug(tx, ctx.organizationId, slug ?? slugify(input.name)),
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!row) throw new Error('appointment type insert returned no row');
  await tx.insert(appointmentTypeHosts).values(
    hosts.map((calendarId) => ({
      organizationId: ctx.organizationId,
      appointmentTypeId: row.id,
      calendarId,
    })),
  );
  return getAppointmentType(tx, ctx.organizationId, row.id);
}

export async function updateAppointmentType(
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updateAppointmentTypeInputSchema>,
): Promise<AppointmentTypeSummary> {
  const {
    hostCalendarIds: hostIds,
    slug,
    ...input
  } = updateAppointmentTypeInputSchema.parse(rawInput);
  const current = await getAppointmentTypeRow(tx, organizationId, id);
  const mode = input.schedulingMode ?? current.schedulingMode;
  const hosts = await validateHosts(
    tx,
    organizationId,
    mode,
    hostIds ?? (await hostCalendarIds(tx, id)),
  );
  await tx
    .update(appointmentTypes)
    .set({
      ...input,
      ...(slug !== undefined ? { slug: await uniqueSlug(tx, organizationId, slug, id) } : {}),
    })
    .where(and(eq(appointmentTypes.id, id), eq(appointmentTypes.organizationId, organizationId)));
  if (hostIds !== undefined) {
    await tx.delete(appointmentTypeHosts).where(eq(appointmentTypeHosts.appointmentTypeId, id));
    await tx
      .insert(appointmentTypeHosts)
      .values(hosts.map((calendarId) => ({ organizationId, appointmentTypeId: id, calendarId })));
  }
  return getAppointmentType(tx, organizationId, id);
}
