import type { CrmContext } from '@businessos/crm';
import {
  appointments,
  calendarBusyBlocks,
  outboxEvents,
  pgErrorInfo,
  PG_ERROR,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError, SecretBox, ValidationError } from '@businessos/shared';
import {
  createTestDatabase,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  addAvailabilityException,
  bookFromPage,
  CalendarProviderRegistry,
  cancelAppointment,
  connectCalendar,
  createAppointmentType,
  createBookingPage,
  createResourceCalendar,
  createStaffAppointment,
  ensureUserCalendar,
  FakeCalendarProvider,
  getAppointment,
  getAvailability,
  listAppointments,
  listAvailableSlots,
  managedAppointmentView,
  rescheduleAppointment,
  resolveManageToken,
  resolvePublicBookingPage,
  setAppointmentStatus,
  setWeeklyRules,
  updateBookingPage,
  type CalendarServices,
  type PublicBookingPage,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
const fakeCalendar = new FakeCalendarProvider();
const services: CalendarServices = {
  providers: new CalendarProviderRegistry([fakeCalendar]),
  secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
  providerTimeoutMs: 500,
};

// Sunday 10 January 2027 is a Bahrain working day; "now" is a week earlier.
const NOW = Date.parse('2027-01-03T00:00:00Z');
const at = (iso: string) => Date.parse(iso);
const SUNDAY_10AM = '2027-01-10T07:00:00.000Z'; // 10:00 Asia/Bahrain

beforeAll(async () => {
  handle = createTestDatabase(16);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(
  org: Organization,
  userId: string | null,
  fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
) {
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, ctxFor(org, userId)),
  );
}

const owner = () => world.orgA.users.owner.id;

function target(page: PublicBookingPage) {
  return {
    organizationId: page.organizationId,
    bookingPageId: page.page.id,
    countryCode: 'BH',
    defaultCurrency: 'BHD',
    timezone: page.organization.timezone,
  };
}

/** A fresh resource calendar with Sun–Thu 09:00–17:00 hours (isolated from other tests). */
async function hostCalendar(org: Organization, name = `Host ${uniqueSuffix()}`) {
  return inOrg(org, null, (tx, ctx) => createResourceCalendar(tx, ctx, { name }));
}

async function bookable(
  org: Organization,
  mode: 'individual' | 'round_robin' | 'collective',
  hostIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const type = await inOrg(org, null, (tx, ctx) =>
    createAppointmentType(tx, ctx, {
      name: `Consultation ${uniqueSuffix()}`,
      durationMinutes: 30,
      schedulingMode: mode,
      hostCalendarIds: hostIds,
      minimumNoticeMinutes: 60,
      maximumAdvanceDays: 30,
      ...overrides,
    }),
  );
  const slug = `book-${uniqueSuffix()}`.toLowerCase();
  await inOrg(org, null, (tx) =>
    createBookingPage(handle.db, tx, org.id, {
      title: 'Book a visit',
      slug,
      appointmentTypeIds: [type.id],
    }),
  );
  const page = await resolvePublicBookingPage(handle.db, slug);
  if (!page) throw new Error('page');
  return { type, page, slug };
}

const invitee = (name = 'Fatima Ali') => ({
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}.${uniqueSuffix()}@example.com`,
  timezone: 'Asia/Bahrain',
});

describe('calendars and availability', () => {
  it('creates one personal calendar per member with the local working week, even under concurrency', async () => {
    const userId = world.orgA.users.sales.id;
    const results = await Promise.all(
      [1, 2, 3].map(() => inOrg(A(), userId, (tx, ctx) => ensureUserCalendar(tx, ctx, userId))),
    );
    expect(new Set(results.map((calendar) => calendar.id)).size).toBe(1);
    const availability = await inOrg(A(), userId, (tx) =>
      getAvailability(tx, A().id, results[0]?.id ?? ''),
    );
    expect(availability.timezone).toBe('Asia/Bahrain');
    expect(availability.rules.map((rule) => rule.weekday)).toEqual([0, 1, 2, 3, 4]);
    // Members of another organization get nothing.
    await expect(
      inOrg(A(), owner(), (tx, ctx) => ensureUserCalendar(tx, ctx, world.orgB.users.admin.id)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('validates working hours and date overrides and isolates tenants', async () => {
    const calendar = await hostCalendar(A());
    await expect(
      inOrg(A(), owner(), (tx) =>
        setWeeklyRules(tx, A().id, calendar.id, {
          rules: [
            { weekday: 1, startMinute: 540, endMinute: 720 },
            { weekday: 1, startMinute: 700, endMinute: 900 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      inOrg(A(), owner(), (tx) =>
        addAvailabilityException(tx, A().id, calendar.id, {
          date: '2027-01-12',
          kind: 'available',
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      inOrg(B(), world.orgB.users.admin.id, (tx) => getAvailability(tx, B().id, calendar.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inOrg(B(), world.orgB.users.admin.id, (tx) =>
        setWeeklyRules(tx, B().id, calendar.id, { rules: [] }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('appointment types and booking pages', () => {
  it('checks hosts and keeps booking links globally unique without revealing their owner', async () => {
    const one = await hostCalendar(A());
    const two = await hostCalendar(A());
    const foreign = await hostCalendar(B());
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        createAppointmentType(tx, ctx, {
          name: 'Two hosts',
          durationMinutes: 30,
          hostCalendarIds: [one.id, two.id],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        createAppointmentType(tx, ctx, {
          name: 'Foreign host',
          durationMinutes: 30,
          schedulingMode: 'round_robin',
          hostCalendarIds: [one.id, foreign.id],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const { type, slug } = await bookable(A(), 'individual', [one.id]);
    const bType = await inOrg(B(), null, (tx, ctx) =>
      createAppointmentType(tx, ctx, {
        name: 'B visit',
        durationMinutes: 30,
        hostCalendarIds: [foreign.id],
      }),
    );
    const bPage = await inOrg(B(), null, (tx) =>
      createBookingPage(handle.db, tx, B().id, {
        title: 'B',
        slug,
        appointmentTypeIds: [bType.id],
      }),
    );
    expect(bPage.slug).not.toBe(slug);
    expect(bPage.slug.startsWith(slug)).toBe(true);
    // Pages only offer the organization's own types.
    await expect(
      inOrg(B(), null, (tx) =>
        createBookingPage(handle.db, tx, B().id, { title: 'Steal', appointmentTypeIds: [type.id] }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inOrg(B(), null, (tx) => updateBookingPage(handle.db, tx, B().id, bPage.id, { slug })),
    ).rejects.toBeInstanceOf(ConflictError);
    // Deactivated pages disappear from the public site.
    await inOrg(B(), null, (tx) =>
      updateBookingPage(handle.db, tx, B().id, bPage.id, { isActive: false }),
    );
    expect(await resolvePublicBookingPage(handle.db, bPage.slug)).toBeNull();
    expect(await resolvePublicBookingPage(handle.db, 'no-such-page-here')).toBeNull();
  });
});

describe('availability', () => {
  it('offers working-hours slots and removes booked, buffered and externally busy time', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id], {
      bufferAfterMinutes: 15,
    });
    const scope = { organizationId: A().id, userId: null };
    const day = { from: at('2027-01-10T00:00:00Z'), to: at('2027-01-11T00:00:00Z') };
    const slots = await listAvailableSlots(handle.db, services, scope, type.id, day, NOW);
    expect(slots).toHaveLength(16);
    expect(new Date(slots[0]?.start ?? 0).toISOString()).toBe('2027-01-10T06:00:00.000Z');
    await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
      NOW,
    );
    const after = (await listAvailableSlots(handle.db, services, scope, type.id, day, NOW)).map(
      (slot) => new Date(slot.start).toISOString(),
    );
    expect(after).not.toContain(SUNDAY_10AM);
    expect(after).not.toContain('2027-01-10T07:30:00.000Z'); // inside the 15-minute buffer
    expect(after).toContain('2027-01-10T08:00:00.000Z');

    // A connected external calendar blocks 12:00–13:00 local; an outage blocks everything.
    const external = `ext-${uniqueSuffix()}`;
    await inOrg(A(), owner(), (tx) =>
      connectCalendar(tx, A().id, services, host.id, {
        provider: 'fake_calendar',
        externalCalendarId: external,
      }),
    );
    fakeCalendar.setBusy(external, [
      { start: at('2027-01-10T09:00:00Z'), end: at('2027-01-10T10:00:00Z') },
    ]);
    const withExternal = (
      await listAvailableSlots(handle.db, services, scope, type.id, day, NOW)
    ).map((slot) => new Date(slot.start).toISOString());
    expect(withExternal).not.toContain('2027-01-10T09:00:00.000Z');
    expect(withExternal).toContain('2027-01-10T10:00:00.000Z');
    fakeCalendar.failNext();
    expect(await listAvailableSlots(handle.db, services, scope, type.id, day, NOW)).toEqual([]);
  });

  it('enforces minimum notice and maximum advance booking on public bookings', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const soon = at('2027-01-10T06:30:00Z'); // 09:30 local, 30 minutes before 10:00
    await expect(
      bookFromPage(
        handle.db,
        services,
        target(page),
        { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
        soon,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      bookFromPage(
        handle.db,
        services,
        target(page),
        {
          appointmentTypeId: type.id,
          startsAt: '2027-03-07T07:00:00.000Z',
          invitee: invitee(),
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // Off-grid and outside-hours times are not bookable either.
    for (const startsAt of ['2027-01-10T07:10:00.000Z', '2027-01-10T15:00:00.000Z']) {
      await expect(
        bookFromPage(
          handle.db,
          services,
          target(page),
          { appointmentTypeId: type.id, startsAt, invitee: invitee() },
          NOW,
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    }
  });
});

describe('double booking (concurrency)', () => {
  async function scheduledOn(calendarIds: string[]) {
    // System scope: the assertion counts rows regardless of tenant.
    return withSystem(handle.db, (tx) =>
      tx
        .select({
          calendarId: calendarBusyBlocks.calendarId,
          appointmentId: calendarBusyBlocks.appointmentId,
        })
        .from(calendarBusyBlocks)
        .where(inArray(calendarBusyBlocks.calendarId, calendarIds)),
    );
  }

  it('lets exactly one of many simultaneous bookings for the same slot succeed', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        bookFromPage(
          handle.db,
          services,
          target(page),
          { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee(`Guest ${index}`) },
          NOW,
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const result of rejected) expect(result.reason).toBeInstanceOf(ConflictError);
    expect(await scheduledOn([host.id])).toHaveLength(1);
  });

  it('never overlaps partially overlapping or buffered bookings made at the same time', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id], {
      slotIntervalMinutes: 15,
      bufferBeforeMinutes: 10,
    });
    const starts = [
      '2027-01-10T07:00:00.000Z',
      '2027-01-10T07:15:00.000Z',
      '2027-01-10T07:30:00.000Z',
    ];
    const results = await Promise.allSettled(
      starts.flatMap((startsAt) =>
        [1, 2].map(() =>
          bookFromPage(
            handle.db,
            services,
            target(page),
            { appointmentTypeId: type.id, startsAt, invitee: invitee() },
            NOW,
          ),
        ),
      ),
    );
    const booked = await withSystem(handle.db, (tx) =>
      tx.select().from(calendarBusyBlocks).where(eq(calendarBusyBlocks.calendarId, host.id)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(booked.length);
    const sorted = booked.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]?.startsAt.getTime()).toBeGreaterThanOrEqual(
        sorted[index - 1]?.endsAt.getTime() ?? 0,
      );
    }
    // 07:00 (busy 06:50–07:30) and 07:30 (busy 07:20–08:00) overlap through the buffer: one wins.
    expect(booked).toHaveLength(1);
  });

  it('assigns simultaneous round-robin bookings to different free hosts and refuses the rest', async () => {
    const one = await hostCalendar(A());
    const two = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'round_robin', [one.id, two.id]);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        bookFromPage(
          handle.db,
          services,
          target(page),
          { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
          NOW,
        ),
      ),
    );
    const booked = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.appointment] : [],
    );
    expect(booked).toHaveLength(2);
    expect(new Set(booked.map((appointment) => appointment.calendar.id))).toEqual(
      new Set([one.id, two.id]),
    );
    expect(await scheduledOn([one.id, two.id])).toHaveLength(2);
  });

  it('keeps team (collective) bookings and individual bookings on a shared host apart', async () => {
    const shared = await hostCalendar(A());
    const other = await hostCalendar(A());
    const team = await bookable(A(), 'collective', [shared.id, other.id]);
    const solo = await bookable(A(), 'individual', [shared.id]);
    const results = await Promise.allSettled([
      bookFromPage(
        handle.db,
        services,
        target(team.page),
        { appointmentTypeId: team.type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
        NOW,
      ),
      bookFromPage(
        handle.db,
        services,
        target(solo.page),
        { appointmentTypeId: solo.type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
        NOW,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const blocks = await scheduledOn([shared.id]);
    expect(blocks).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status === 'fulfilled' && winner.value.appointment.hosts.length === 2) {
      // The team booking holds both calendars.
      expect(await scheduledOn([other.id])).toHaveLength(1);
    } else {
      expect(await scheduledOn([other.id])).toHaveLength(0);
    }
  });

  it('is enforced by the database itself (exclusion constraint)', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const first = await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
      NOW,
    );
    // An appointment held on a different calendar, so only the overlap rule can object.
    const elsewhere = await hostCalendar(A());
    const second = await createStaffAppointment(
      handle.db,
      services,
      ctxFor(A(), owner()),
      { calendarId: elsewhere.id, title: 'Elsewhere', durationMinutes: 30, startsAt: SUNDAY_10AM },
      NOW,
    );
    expect(first.appointment.id).not.toBe(second.appointment.id);
    // Bypassing every application check: a raw block overlapping another booking is rejected.
    await expect(
      inOrg(A(), null, (tx) =>
        tx.insert(calendarBusyBlocks).values({
          organizationId: A().id,
          calendarId: host.id,
          appointmentId: second.appointment.id,
          startsAt: new Date(at('2027-01-10T07:10:00Z')),
          endsAt: new Date(at('2027-01-10T07:20:00Z')),
        }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.exclusionViolation,
    );
  });
});

describe('appointment lifecycle', () => {
  it('books staff appointments, cancels, reschedules safely and records events', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const public1 = await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee('Mona Saleh') },
      NOW,
    );
    expect(public1.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(public1.appointment.contact?.name).toBe('Mona Saleh');
    const ctx = ctxFor(A(), owner());
    // Staff booking outside working hours is allowed only with an explicit override.
    await expect(
      createStaffAppointment(
        handle.db,
        services,
        ctx,
        { appointmentTypeId: type.id, startsAt: '2027-01-10T16:00:00.000Z' },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const late = await createStaffAppointment(
      handle.db,
      services,
      ctx,
      {
        appointmentTypeId: type.id,
        startsAt: '2027-01-10T16:00:00.000Z',
        ignoreAvailability: true,
        contactId: public1.appointment.contact?.id ?? null,
      },
      NOW,
    );
    expect(late.appointment.source).toBe('staff');
    // …but never on top of an existing booking.
    await expect(
      createStaffAppointment(
        handle.db,
        services,
        ctx,
        { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, ignoreAvailability: true },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Rescheduling onto a taken time fails and leaves the appointment untouched.
    await expect(
      rescheduleAppointment(
        handle.db,
        services,
        ctx,
        late.appointment.id,
        { startsAt: SUNDAY_10AM, ignoreAvailability: true },
        'staff',
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const unchanged = await inOrg(A(), owner(), (tx, c) =>
      getAppointment(tx, c, late.appointment.id),
    );
    expect(unchanged.startsAt).toBe('2027-01-10T16:00:00.000Z');

    const moved = await rescheduleAppointment(
      handle.db,
      services,
      ctxFor(A(), null),
      public1.appointment.id,
      { startsAt: '2027-01-11T07:00:00.000Z' },
      'invitee',
      NOW,
    );
    expect(moved.startsAt).toBe('2027-01-11T07:00:00.000Z');
    // The old time is free again; the new one is held.
    const rebook = await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
      NOW,
    );
    await inOrg(A(), owner(), (tx, c) =>
      cancelAppointment(tx, c, rebook.appointment.id, { reason: 'Customer called' }, 'staff'),
    );
    await expect(
      inOrg(A(), owner(), (tx, c) => cancelAppointment(tx, c, rebook.appointment.id, {}, 'staff')),
    ).rejects.toBeInstanceOf(ConflictError);
    const blocks = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(calendarBusyBlocks)
        .where(eq(calendarBusyBlocks.appointmentId, rebook.appointment.id)),
    );
    expect(blocks).toHaveLength(0);

    // Completed/no-show only after the start.
    await expect(
      inOrg(A(), owner(), (tx, c) =>
        setAppointmentStatus(tx, c, moved.id, { status: 'completed' }, NOW),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const done = await inOrg(A(), owner(), (tx, c) =>
      setAppointmentStatus(tx, c, moved.id, { status: 'no_show' }, at('2027-01-11T08:00:00Z')),
    );
    expect(done.status).toBe('no_show');

    const events = await withSystem(handle.db, (tx) =>
      tx
        .select({ type: outboxEvents.type, subjectId: outboxEvents.subjectId })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.organizationId, A().id),
            inArray(outboxEvents.subjectId, [public1.appointment.id, rebook.appointment.id]),
          ),
        ),
    );
    expect(events.map((event) => event.type).toSorted()).toEqual([
      'appointment.booked',
      'appointment.booked',
      'appointment.cancelled',
      'appointment.rescheduled',
      'appointment.status_changed',
    ]);
    const listed = await inOrg(A(), owner(), (tx, c) =>
      listAppointments(tx, c, { calendarId: host.id, status: 'all', limit: 2 }),
    );
    expect(listed.data).toHaveLength(2);
    expect(listed.nextCursor).not.toBeNull();
    const rest = await inOrg(A(), owner(), (tx, c) =>
      listAppointments(tx, c, {
        calendarId: host.id,
        status: 'all',
        limit: 10,
        cursor: listed.nextCursor ?? undefined,
      }),
    );
    expect(rest.data.length).toBeGreaterThan(0);
    expect(rest.data.some((row) => listed.data.some((first) => first.id === row.id))).toBe(false);
  });

  it('gives invitees a manage link scoped to their own appointment and tenant', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const booked = await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
      NOW,
    );
    const token = booked.manageToken ?? '';
    const resolved = await resolveManageToken(handle.db, token, NOW);
    expect(resolved).toEqual({ organizationId: A().id, appointmentId: booked.appointment.id });
    expect(await resolveManageToken(handle.db, `${token.slice(0, -1)}x`, NOW)).toBeNull();
    expect(await resolveManageToken(handle.db, 'short', NOW)).toBeNull();
    // Expired 30 days after the appointment.
    expect(await resolveManageToken(handle.db, token, at('2027-02-12T00:00:00Z'))).toBeNull();
    const view = await inOrg(A(), null, (tx) =>
      managedAppointmentView(tx, A().id, booked.appointment.id, NOW),
    );
    expect(view).toMatchObject({ status: 'scheduled', canChange: true, timezone: 'Asia/Bahrain' });
    expect(view).not.toHaveProperty('inviteeEmail');
  });

  it('keeps appointments inside their tenant', async () => {
    const host = await hostCalendar(A());
    const { type, page } = await bookable(A(), 'individual', [host.id]);
    const booked = await bookFromPage(
      handle.db,
      services,
      target(page),
      { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
      NOW,
    );
    const bAdmin = world.orgB.users.admin.id;
    await expect(
      inOrg(B(), bAdmin, (tx, ctx) => getAppointment(tx, ctx, booked.appointment.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inOrg(B(), bAdmin, (tx, ctx) =>
        cancelAppointment(tx, ctx, booked.appointment.id, {}, 'staff'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      rescheduleAppointment(
        handle.db,
        services,
        ctxFor(B(), bAdmin),
        booked.appointment.id,
        { startsAt: '2027-01-11T07:00:00.000Z' },
        'staff',
        NOW,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const bList = await inOrg(B(), bAdmin, (tx, ctx) =>
      listAppointments(tx, ctx, { status: 'all', limit: 200 }),
    );
    expect(bList.data.map((row) => row.id)).not.toContain(booked.appointment.id);
    // Org B cannot book Org A's type through its own page or with A's calendar as host.
    const bHost = await hostCalendar(B());
    const bPage = await bookable(B(), 'individual', [bHost.id]);
    await expect(
      bookFromPage(
        handle.db,
        services,
        target(bPage.page),
        { appointmentTypeId: type.id, startsAt: SUNDAY_10AM, invitee: invitee() },
        NOW,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createStaffAppointment(
        handle.db,
        services,
        ctxFor(B(), bAdmin),
        { calendarId: host.id, title: 'x', durationMinutes: 30, startsAt: SUNDAY_10AM },
        NOW,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createStaffAppointment(
        handle.db,
        services,
        ctxFor(B(), bAdmin),
        {
          calendarId: bHost.id,
          title: 'x',
          durationMinutes: 30,
          startsAt: '2027-01-12T07:00:00.000Z',
          contactId: booked.appointment.contact?.id ?? null,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // RLS: a raw query in B's scope sees none of A's rows.
    const raw = await inOrg(B(), bAdmin, (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, booked.appointment.id)),
    );
    expect(raw).toHaveLength(0);
  });
});
