// Invitee manage links: view, cancel or reschedule without an account.
import { type CrmContext } from '@businessos/crm';
import {
  appointmentManageTokens,
  bookingPages,
  organizations,
  withSystem,
  type Appointment,
  type Database,
  type TenantTx,
} from '@businessos/database';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DAY_MS } from './time';
import { getAppointmentRow } from './appointments';

/** SHA-256 of an invitee manage token (only the hash is stored). */
export function hashManageToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a manage link token for the invitee (valid until 30 days after the appointment). */
export async function createManageToken(
  tx: TenantTx,
  organizationId: string,
  appointment: Pick<Appointment, 'id' | 'endsAt'>,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx.insert(appointmentManageTokens).values({
    organizationId,
    appointmentId: appointment.id,
    tokenHash: hashManageToken(token),
    expiresAt: new Date(appointment.endsAt.getTime() + 30 * DAY_MS),
  });
  return token;
}

/** Organization and appointment behind an invitee manage token (system-scope token lookup). */
export async function resolveManageToken(
  db: Database,
  token: string,
  now = Date.now(),
): Promise<{ organizationId: string; appointmentId: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({
        organizationId: appointmentManageTokens.organizationId,
        appointmentId: appointmentManageTokens.appointmentId,
      })
      .from(appointmentManageTokens)
      .innerJoin(organizations, eq(organizations.id, appointmentManageTokens.organizationId))
      .where(
        and(
          eq(appointmentManageTokens.tokenHash, hashManageToken(token)),
          gt(appointmentManageTokens.expiresAt, new Date(now)),
          isNull(organizations.deletedAt),
        ),
      ),
  );
  return row ?? null;
}

export interface ManagedAppointmentView {
  id: string;
  title: string;
  status: Appointment['status'];
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationKind: Appointment['locationKind'];
  locationDetails: string | null;
  joinUrl: string | null;
  inviteeName: string | null;
  organization: { name: string };
  appointmentTypeId: string | null;
  bookingPageSlug: string | null;
  canChange: boolean;
}

/** What the invitee sees on their manage page (no staff-only data). */
export async function managedAppointmentView(
  tx: TenantTx,
  organizationId: string,
  appointmentId: string,
  now = Date.now(),
): Promise<ManagedAppointmentView> {
  const appointment = await getAppointmentRow(tx, organizationId, appointmentId);
  const [organization] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const [page] = appointment.bookingPageId
    ? await tx
        .select({ slug: bookingPages.slug, isActive: bookingPages.isActive })
        .from(bookingPages)
        .where(eq(bookingPages.id, appointment.bookingPageId))
    : [];
  return {
    id: appointment.id,
    title: appointment.title,
    status: appointment.status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    timezone: appointment.timezone,
    locationKind: appointment.locationKind,
    locationDetails: appointment.locationDetails,
    joinUrl: appointment.joinUrl,
    inviteeName: appointment.inviteeName,
    organization: { name: organization?.name ?? '' },
    appointmentTypeId: appointment.appointmentTypeId,
    bookingPageSlug: page?.isActive ? page.slug : null,
    canChange: appointment.status === 'scheduled' && appointment.startsAt.getTime() > now,
  };
}

/** Context for changes made by an invitee through a manage link (system actor). */
export function inviteeContext(organization: {
  id: string;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
}): CrmContext {
  return {
    organizationId: organization.id,
    countryCode: organization.countryCode,
    defaultCurrency: organization.defaultCurrency,
    timezone: organization.timezone,
    actor: { type: 'system', userId: null },
  };
}
