import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  addAvailabilityException,
  appointmentListQuerySchema,
  cancelAppointment,
  connectCalendar,
  createAppointmentType,
  createBookingPage,
  createResourceCalendar,
  createStaffAppointment,
  deleteAvailabilityException,
  deleteBookingPage,
  disconnectCalendar,
  ensureUserCalendar,
  getAppointment,
  getAppointmentType,
  getAvailability,
  getBookingPage,
  getCalendar,
  getCalendarRow,
  listAppointments,
  listAppointmentTypes,
  listAvailableSlots,
  listBookingPages,
  listCalendarConnections,
  listCalendars,
  rescheduleAppointment,
  setAppointmentStatus,
  setWeeklyRules,
  updateAppointmentType,
  updateBookingPage,
  updateCalendar,
  type AppointmentSummary,
} from '@businessos/calendar';
import type { CrmContext } from '@businessos/crm';
import { calendarConnections, withTenant, type TenantTx } from '@businessos/database';
import { ForbiddenError, NotFoundError } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requirePermission,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';
import { issueManageLink, notifyInvitee, queueCalendarSync } from './notify';

const idParams = z.object({ id: z.uuid() });
const exceptionParams = z.object({ id: z.uuid(), exceptionId: z.uuid() });
const slotQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

function context(request: FastifyRequest, tenant: TenantContext): CrmContext {
  return {
    organizationId: tenant.organizationId,
    countryCode: tenant.organization.countryCode,
    defaultCurrency: tenant.organization.defaultCurrency,
    timezone: tenant.organization.timezone,
    actor: { type: 'user', userId: tenant.userId, correlationId: request.id },
    canRead: {
      contact: tenant.permissions.has('crm.contact.read'),
      company: tenant.permissions.has('crm.company.read'),
      deal: tenant.permissions.has('crm.deal.read'),
    },
  };
}

/** `/app/orgs/:orgId/calendar/*` — calendars, availability, types, booking pages, appointments. */
export function calendarRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  function run<T>(
    request: FastifyRequest,
    tenant: TenantContext,
    fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(db(), tenantScope(tenant), (tx) => fn(tx, context(request, tenant)));
  }

  function audit(
    tx: TenantTx,
    request: FastifyRequest,
    tenant: TenantContext,
    action: AuditAction,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ) {
    return recordAudit(tx, auditContext(request), {
      organizationId: tenant.organizationId,
      action,
      target,
      metadata,
    });
  }

  /**
   * Availability and connections of a calendar: `calendar.manage`, or the member's own
   * personal calendar with `calendar.appointment.manage`.
   */
  async function requireCalendarEditor(request: FastifyRequest, calendarId: string) {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const calendar = await run(request, tenant, (tx) =>
      getCalendarRow(tx, tenant.organizationId, calendarId),
    );
    const own =
      calendar.userId === tenant.userId && tenant.permissions.has('calendar.appointment.manage');
    if (!own && !tenant.permissions.has('calendar.manage')) throw new ForbiddenError();
    return tenant;
  }

  async function afterChange(
    request: FastifyRequest,
    tenant: TenantContext,
    appointment: AppointmentSummary,
    template: 'appointment_confirmed' | 'appointment_rescheduled' | 'appointment_cancelled',
    manageToken: string | null,
  ) {
    await queueCalendarSync(app, tenant.organizationId, appointment, request.id);
    await notifyInvitee(app, {
      appointment,
      organizationName: tenant.organization.name,
      template,
      manageToken,
      correlationId: request.id,
    });
  }

  // ── Calendars & availability ──────────────────────────────────────────────────────────
  app.get('/calendars', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    return { data: await run(request, tenant, (tx) => listCalendars(tx, tenant.organizationId)) };
  });

  /** The caller's personal calendar (created on first use with default working hours). */
  app.post('/calendars/me', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.manage');
    return {
      calendar: await run(request, tenant, (tx, ctx) => ensureUserCalendar(tx, ctx, tenant.userId)),
    };
  });

  app.post('/calendars', async (request, reply) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const calendar = await run(request, tenant, async (tx, ctx) => {
      const created = await createResourceCalendar(
        tx,
        ctx,
        request.body as Parameters<typeof createResourceCalendar>[2],
      );
      await audit(tx, request, tenant, 'calendar.calendar.created', {
        type: 'calendar',
        id: created.id,
      });
      return created;
    });
    return reply.status(201).send({ calendar });
  });

  app.get('/calendars/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    return {
      calendar: await run(request, tenant, (tx) => getCalendar(tx, tenant.organizationId, id)),
    };
  });

  app.patch('/calendars/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({
        name: z.unknown().optional(),
        timezone: z.unknown().optional(),
        isActive: z.unknown().optional(),
      }),
      request.body,
    );
    // Activating or deactivating a calendar is an administrative change.
    const tenant =
      body.isActive === undefined
        ? await requireCalendarEditor(request, id)
        : requirePermission(request, 'calendar.manage');
    return {
      calendar: await run(request, tenant, async (tx) => {
        const updated = await updateCalendar(
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof updateCalendar>[3],
        );
        await audit(
          tx,
          request,
          tenant,
          'calendar.calendar.updated',
          { type: 'calendar', id },
          {
            fields: Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined),
          },
        );
        return updated;
      }),
    };
  });

  app.get('/calendars/:id/availability', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    return {
      availability: await run(request, tenant, (tx) =>
        getAvailability(tx, tenant.organizationId, id),
      ),
    };
  });

  app.put('/calendars/:id/availability', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const tenant = await requireCalendarEditor(request, id);
    return {
      availability: await run(request, tenant, (tx) =>
        setWeeklyRules(
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof setWeeklyRules>[3],
        ),
      ),
    };
  });

  app.post('/calendars/:id/exceptions', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const tenant = await requireCalendarEditor(request, id);
    const created = await run(request, tenant, (tx) =>
      addAvailabilityException(
        tx,
        tenant.organizationId,
        id,
        request.body as Parameters<typeof addAvailabilityException>[3],
      ),
    );
    return reply.status(201).send(created);
  });

  app.delete('/calendars/:id/exceptions/:exceptionId', async (request, reply) => {
    const { id, exceptionId } = parseInput(exceptionParams, request.params);
    const tenant = await requireCalendarEditor(request, id);
    await run(request, tenant, (tx) =>
      deleteAvailabilityException(tx, tenant.organizationId, id, exceptionId),
    );
    return reply.status(204).send();
  });

  // ── Calendar connections (external calendars) ─────────────────────────────────────────
  app.get('/calendar-providers', (request) => {
    requirePermission(request, 'calendar.appointment.manage');
    return {
      encryptionConfigured: app.calendar.secretBox !== null,
      data: app.calendar.providers.list().map((provider) => ({
        key: provider.key,
        label: provider.label,
        credentialFields: provider.credentialFields,
      })),
    };
  });

  app.get('/calendars/:id/connections', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const tenant = await requireCalendarEditor(request, id);
    return {
      data: await run(request, tenant, (tx) =>
        listCalendarConnections(tx, tenant.organizationId, app.calendar, id),
      ),
    };
  });

  app.post('/calendars/:id/connections', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const tenant = await requireCalendarEditor(request, id);
    const connection = await run(request, tenant, async (tx) => {
      const created = await connectCalendar(
        tx,
        tenant.organizationId,
        app.calendar,
        id,
        request.body as Parameters<typeof connectCalendar>[4],
      );
      await audit(
        tx,
        request,
        tenant,
        'calendar.connection.connected',
        { type: 'calendar_connection', id: created.id },
        { provider: created.provider, calendarId: id, configuredFields: created.configuredFields },
      );
      return created;
    });
    return reply.status(201).send({ connection });
  });

  app.delete('/calendar-connections/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const reader = requirePermission(request, 'calendar.appointment.read');
    const [row] = await run(request, reader, (tx) =>
      tx
        .select({ calendarId: calendarConnections.calendarId })
        .from(calendarConnections)
        .where(
          and(
            eq(calendarConnections.id, id),
            eq(calendarConnections.organizationId, reader.organizationId),
          ),
        ),
    );
    if (!row) throw new NotFoundError('Calendar connection');
    const tenant = await requireCalendarEditor(request, row.calendarId);
    await run(request, tenant, async (tx) => {
      const disconnected = await disconnectCalendar(tx, tenant.organizationId, app.calendar, id);
      await audit(
        tx,
        request,
        tenant,
        'calendar.connection.disconnected',
        {
          type: 'calendar_connection',
          id,
        },
        { provider: disconnected.provider },
      );
    });
    return reply.status(204).send();
  });

  // ── Appointment types ─────────────────────────────────────────────────────────────────
  app.get('/appointment-types', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    return {
      data: await run(request, tenant, (tx) => listAppointmentTypes(tx, tenant.organizationId)),
    };
  });

  app.post('/appointment-types', async (request, reply) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const type = await run(request, tenant, async (tx, ctx) => {
      const created = await createAppointmentType(
        tx,
        ctx,
        request.body as Parameters<typeof createAppointmentType>[2],
      );
      await audit(
        tx,
        request,
        tenant,
        'calendar.appointment_type.created',
        {
          type: 'appointment_type',
          id: created.id,
        },
        { name: created.name, schedulingMode: created.schedulingMode },
      );
      return created;
    });
    return reply.status(201).send({ appointmentType: type });
  });

  app.get('/appointment-types/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    return {
      appointmentType: await run(request, tenant, (tx) =>
        getAppointmentType(tx, tenant.organizationId, id),
      ),
    };
  });

  app.patch('/appointment-types/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      appointmentType: await run(request, tenant, async (tx) => {
        const updated = await updateAppointmentType(
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof updateAppointmentType>[3],
        );
        await audit(tx, request, tenant, 'calendar.appointment_type.updated', {
          type: 'appointment_type',
          id,
        });
        return updated;
      }),
    };
  });

  app.get('/appointment-types/:id/slots', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(slotQuery, request.query);
    const slots = await listAvailableSlots(db(), app.calendar, tenantScope(tenant), id, {
      from: Date.parse(query.from),
      to: Date.parse(query.to),
    });
    return {
      data: slots.map((slot) => ({
        startsAt: new Date(slot.start).toISOString(),
        calendarIds: slot.calendarIds,
      })),
    };
  });

  // ── Booking pages ─────────────────────────────────────────────────────────────────────
  app.get('/booking-pages', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    return {
      data: await run(request, tenant, (tx) => listBookingPages(tx, tenant.organizationId)),
    };
  });

  app.post('/booking-pages', async (request, reply) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const page = await run(request, tenant, async (tx) => {
      const created = await createBookingPage(
        db(),
        tx,
        tenant.organizationId,
        request.body as Parameters<typeof createBookingPage>[3],
      );
      await audit(
        tx,
        request,
        tenant,
        'calendar.booking_page.created',
        {
          type: 'booking_page',
          id: created.id,
        },
        { slug: created.slug },
      );
      return created;
    });
    return reply.status(201).send({ bookingPage: page });
  });

  app.get('/booking-pages/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    return {
      bookingPage: await run(request, tenant, (tx) =>
        getBookingPage(tx, tenant.organizationId, id),
      ),
    };
  });

  app.patch('/booking-pages/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      bookingPage: await run(request, tenant, async (tx) => {
        const updated = await updateBookingPage(
          db(),
          tx,
          tenant.organizationId,
          id,
          request.body as Parameters<typeof updateBookingPage>[4],
        );
        await audit(
          tx,
          request,
          tenant,
          'calendar.booking_page.updated',
          {
            type: 'booking_page',
            id,
          },
          { slug: updated.slug, isActive: updated.isActive },
        );
        return updated;
      }),
    };
  });

  app.delete('/booking-pages/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'calendar.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx) => {
      const deleted = await deleteBookingPage(tx, tenant.organizationId, id);
      await audit(
        tx,
        request,
        tenant,
        'calendar.booking_page.deleted',
        {
          type: 'booking_page',
          id,
        },
        { slug: deleted.slug },
      );
    });
    return reply.status(204).send();
  });

  // ── Appointments ──────────────────────────────────────────────────────────────────────
  app.get('/appointments', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const query = parseInput(appointmentListQuerySchema, request.query);
    return run(request, tenant, (tx, ctx) => listAppointments(tx, ctx, query));
  });

  app.get('/appointments/:id', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.read');
    const { id } = parseInput(idParams, request.params);
    return { appointment: await run(request, tenant, (tx, ctx) => getAppointment(tx, ctx, id)) };
  });

  app.post('/appointments', async (request, reply) => {
    const tenant = requirePermission(request, 'calendar.appointment.manage');
    const body = parseInput(z.object({ contactId: z.unknown().optional() }), request.body);
    if (body.contactId && !tenant.permissions.has('crm.contact.read')) throw new ForbiddenError();
    const result = await createStaffAppointment(
      db(),
      app.calendar,
      context(request, tenant),
      request.body as Parameters<typeof createStaffAppointment>[3],
    );
    await afterChange(
      request,
      tenant,
      result.appointment,
      'appointment_confirmed',
      result.manageToken,
    );
    return reply.status(201).send({ appointment: result.appointment });
  });

  app.post('/appointments/:id/cancel', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.manage');
    const { id } = parseInput(idParams, request.params);
    const appointment = await run(request, tenant, async (tx, ctx) => {
      await cancelAppointment(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof cancelAppointment>[3],
        'staff',
      );
      return getAppointment(tx, ctx, id);
    });
    await afterChange(request, tenant, appointment, 'appointment_cancelled', null);
    return { appointment };
  });

  app.post('/appointments/:id/reschedule', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.manage');
    const { id } = parseInput(idParams, request.params);
    const appointment = await rescheduleAppointment(
      db(),
      app.calendar,
      context(request, tenant),
      id,
      request.body as Parameters<typeof rescheduleAppointment>[4],
      'staff',
    );
    const token = appointment.invitee.email
      ? await issueManageLink(app, tenant.organizationId, appointment.id)
      : null;
    await afterChange(request, tenant, appointment, 'appointment_rescheduled', token);
    return { appointment };
  });

  app.post('/appointments/:id/status', async (request) => {
    const tenant = requirePermission(request, 'calendar.appointment.manage');
    const { id } = parseInput(idParams, request.params);
    return {
      appointment: await run(request, tenant, (tx, ctx) =>
        setAppointmentStatus(
          tx,
          ctx,
          id,
          request.body as Parameters<typeof setAppointmentStatus>[3],
        ),
      ),
    };
  });
}
