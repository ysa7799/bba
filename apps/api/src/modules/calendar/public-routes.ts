import {
  bookFromPage,
  cancelAppointment,
  getAppointment,
  inviteeContext,
  listAvailableSlots,
  managedAppointmentView,
  rescheduleAppointment,
  resolveManageToken,
  resolvePublicBookingPage,
  type PublicBookingPage,
} from '@businessos/calendar';
import { appointmentTypes, organizations, withTenant } from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { issueManageLink, notifyInvitee, queueCalendarSync } from './notify';

const slugParams = z.object({ slug: z.string().min(3).max(64) });
const typeParams = slugParams.extend({ typeId: z.uuid() });
const tokenParams = z.object({ token: z.string().min(40).max(60) });
const slotQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
/** Real visitors never fill the hidden `website` field; bots usually do. */
const honeypot = z.object({ website: z.string().max(200).optional() });

/**
 * `/public/booking/*` — unauthenticated booking pages and invitee manage links. The slug or
 * token resolves the tenant (system-scope lookup); all other work runs in that tenant. Every
 * route is rate limited per client IP, bookings also per page.
 */
export function publicBookingRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  async function page(request: FastifyRequest, slug: string): Promise<PublicBookingPage> {
    await app.rateLimiter.consume('bookingReadIp', request.ip);
    const resolved = await resolvePublicBookingPage(db(), slug);
    if (!resolved) throw new NotFoundError('Booking page');
    return resolved;
  }

  async function managed(request: FastifyRequest, token: string) {
    await app.rateLimiter.consume('bookingManageIp', request.ip);
    const resolved = await resolveManageToken(db(), token);
    if (!resolved) throw new NotFoundError('Appointment');
    const organization = await withTenant(
      db(),
      { organizationId: resolved.organizationId, userId: null },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, resolved.organizationId));
        return row;
      },
    );
    if (!organization) throw new NotFoundError('Appointment');
    return { ...resolved, organization, ctx: inviteeContext(organization) };
  }

  /**
   * Invitees may change only future, scheduled appointments of a type that is still offered
   * (staff can change anything through the app).
   */
  async function assertChangeable(organizationId: string, appointmentId: string) {
    const current = await view(organizationId, appointmentId);
    if (!current.canChange) {
      throw new ConflictError('This appointment can no longer be changed online');
    }
    return current;
  }

  async function typeIsActive(organizationId: string, typeId: string): Promise<boolean> {
    const rows = await withTenant(db(), { organizationId, userId: null }, (tx) =>
      tx
        .select({ id: appointmentTypes.id })
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.id, typeId), eq(appointmentTypes.isActive, true))),
    );
    return rows.length > 0;
  }

  function view(organizationId: string, appointmentId: string) {
    return withTenant(db(), { organizationId, userId: null }, (tx) =>
      managedAppointmentView(tx, organizationId, appointmentId),
    );
  }

  app.get('/pages/:slug', async (request) => {
    const { slug } = parseInput(slugParams, request.params);
    const resolved = await page(request, slug);
    return {
      page: {
        slug: resolved.page.slug,
        title: resolved.page.title,
        description: resolved.page.description,
      },
      organization: { name: resolved.organization.name, timezone: resolved.organization.timezone },
      appointmentTypes: resolved.appointmentTypes,
    };
  });

  app.get('/pages/:slug/types/:typeId/slots', async (request) => {
    const { slug, typeId } = parseInput(typeParams, request.params);
    const query = parseInput(slotQuery, request.query);
    const resolved = await page(request, slug);
    if (!resolved.appointmentTypes.some((type) => type.id === typeId)) {
      throw new NotFoundError('Appointment type');
    }
    const slots = await listAvailableSlots(
      db(),
      app.calendar,
      { organizationId: resolved.organizationId, userId: null },
      typeId,
      { from: Date.parse(query.from), to: Date.parse(query.to) },
    );
    // Only times: which host is free is internal.
    return { data: slots.map((slot) => new Date(slot.start).toISOString()) };
  });

  app.post('/pages/:slug/book', async (request, reply) => {
    const { slug } = parseInput(slugParams, request.params);
    if (parseInput(honeypot, request.body).website) {
      throw new ValidationError('Invalid submission');
    }
    await app.rateLimiter.consume('bookingCreateIp', request.ip);
    const resolved = await page(request, slug);
    await app.rateLimiter.consume('bookingCreatePage', resolved.page.id);
    const result = await bookFromPage(
      db(),
      app.calendar,
      {
        organizationId: resolved.organizationId,
        bookingPageId: resolved.page.id,
        countryCode: resolved.organization.countryCode,
        defaultCurrency: resolved.organization.defaultCurrency,
        timezone: resolved.organization.timezone,
      },
      request.body as Parameters<typeof bookFromPage>[3],
    );
    await queueCalendarSync(app, resolved.organizationId, result.appointment, request.id);
    await notifyInvitee(app, {
      appointment: result.appointment,
      organizationName: resolved.organization.name,
      template: 'appointment_confirmed',
      manageToken: result.manageToken,
      correlationId: request.id,
    });
    return reply.status(201).send({
      appointment: await view(resolved.organizationId, result.appointment.id),
      manageToken: result.manageToken,
    });
  });

  app.get('/manage/:token', async (request) => {
    const { token } = parseInput(tokenParams, request.params);
    const target = await managed(request, token);
    return { appointment: await view(target.organizationId, target.appointmentId) };
  });

  app.get('/manage/:token/slots', async (request) => {
    const { token } = parseInput(tokenParams, request.params);
    const query = parseInput(slotQuery, request.query);
    const target = await managed(request, token);
    const appointment = await view(target.organizationId, target.appointmentId);
    if (!appointment.canChange || !appointment.appointmentTypeId) return { data: [] };
    const typeId = appointment.appointmentTypeId;
    if (!(await typeIsActive(target.organizationId, typeId))) return { data: [] };
    const slots = await listAvailableSlots(
      db(),
      app.calendar,
      { organizationId: target.organizationId, userId: null },
      typeId,
      { from: Date.parse(query.from), to: Date.parse(query.to) },
    );
    return { data: slots.map((slot) => new Date(slot.start).toISOString()) };
  });

  app.post('/manage/:token/cancel', async (request) => {
    const { token } = parseInput(tokenParams, request.params);
    const target = await managed(request, token);
    await assertChangeable(target.organizationId, target.appointmentId);
    const appointment = await withTenant(
      db(),
      { organizationId: target.organizationId, userId: null },
      async (tx) => {
        await cancelAppointment(
          tx,
          target.ctx,
          target.appointmentId,
          request.body as Parameters<typeof cancelAppointment>[3],
          'invitee',
        );
        return getAppointment(tx, target.ctx, target.appointmentId);
      },
    );
    await queueCalendarSync(app, target.organizationId, appointment, request.id);
    await notifyInvitee(app, {
      appointment,
      organizationName: target.organization.name,
      template: 'appointment_cancelled',
      manageToken: null,
      correlationId: request.id,
    });
    return { appointment: await view(target.organizationId, target.appointmentId) };
  });

  app.post('/manage/:token/reschedule', async (request) => {
    const { token } = parseInput(tokenParams, request.params);
    const body = parseInput(z.object({ startsAt: z.iso.datetime({ offset: true }) }), request.body);
    const target = await managed(request, token);
    const current = await assertChangeable(target.organizationId, target.appointmentId);
    if (
      !current.appointmentTypeId ||
      !(await typeIsActive(target.organizationId, current.appointmentTypeId))
    ) {
      throw new ConflictError('This appointment cannot be rescheduled online');
    }
    const appointment = await rescheduleAppointment(
      db(),
      app.calendar,
      target.ctx,
      target.appointmentId,
      { startsAt: body.startsAt },
      'invitee',
    );
    await queueCalendarSync(app, target.organizationId, appointment, request.id);
    await notifyInvitee(app, {
      appointment,
      organizationName: target.organization.name,
      template: 'appointment_rescheduled',
      manageToken: await issueManageLink(app, target.organizationId, appointment.id),
      correlationId: request.id,
    });
    return { appointment: await view(target.organizationId, target.appointmentId) };
  });
}
