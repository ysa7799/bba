import { projectEvent, listActivities } from '@businessos/activities';
import type { CrmContext } from '@businessos/crm';
import {
  appointmentExternalEvents,
  appointments,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { SecretBox } from '@businessos/shared';
import {
  createTestDatabase,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookFromPage,
  calendarTimelineProjectors,
  CalendarProviderRegistry,
  cancelAppointment,
  connectCalendar,
  createAppointmentType,
  createBookingPage,
  createResourceCalendar,
  FakeCalendarProvider,
  processDueReminders,
  rescheduleAppointment,
  resolveManageToken,
  resolvePublicBookingPage,
  syncAppointmentEvents,
  type AppointmentEmail,
  type CalendarServices,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
const fake = new FakeCalendarProvider();
const services: CalendarServices = {
  providers: new CalendarProviderRegistry([fake]),
  secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
};
const NOW = Date.parse('2027-01-03T00:00:00Z');

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization;

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(org: Organization, fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>) {
  return withTenant(handle.db, { organizationId: org.id, userId: null }, (tx) =>
    fn(tx, ctxFor(org, null)),
  );
}

async function setup(options: { connect?: boolean } = {}) {
  const host = await inOrg(A(), (tx, ctx) =>
    createResourceCalendar(tx, ctx, { name: `Host ${uniqueSuffix()}` }),
  );
  const type = await inOrg(A(), (tx, ctx) =>
    createAppointmentType(tx, ctx, {
      name: 'Site visit',
      durationMinutes: 30,
      hostCalendarIds: [host.id],
      locationKind: 'video',
    }),
  );
  const slug = `jobs-${uniqueSuffix()}`.toLowerCase();
  await inOrg(A(), (tx) =>
    createBookingPage(handle.db, tx, A().id, {
      title: 'Jobs',
      slug,
      appointmentTypeIds: [type.id],
    }),
  );
  const page = await resolvePublicBookingPage(handle.db, slug);
  if (!page) throw new Error('page');
  const external = `ext-${uniqueSuffix()}`;
  if (options.connect) {
    await inOrg(A(), (tx) =>
      connectCalendar(tx, A().id, services, host.id, {
        provider: 'fake_calendar',
        externalCalendarId: external,
      }),
    );
  }
  const book = (startsAt: string, now = NOW) =>
    bookFromPage(
      handle.db,
      services,
      {
        organizationId: A().id,
        bookingPageId: page.page.id,
        countryCode: 'BH',
        defaultCurrency: 'BHD',
        timezone: 'Asia/Bahrain',
      },
      {
        appointmentTypeId: type.id,
        startsAt,
        invitee: {
          name: 'Layla Hassan',
          email: `layla.${uniqueSuffix()}@example.com`,
          timezone: 'Asia/Bahrain',
        },
      },
      now,
    );
  return { host, type, book };
}

describe('reminders', () => {
  it('sends each due reminder once with a fresh manage link and retries failed sends', async () => {
    const { book } = await setup();
    const booked = await book('2027-01-10T07:00:00.000Z');
    const sent: AppointmentEmail[] = [];
    const run = (
      now: number,
      send = (email: AppointmentEmail) => {
        sent.push(email);
        return Promise.resolve();
      },
    ) => processDueReminders(handle.db, { now, appUrl: 'https://app.example.com/', send });
    // Not yet due (more than 24 hours ahead).
    await run(Date.parse('2027-01-08T00:00:00Z'));
    expect(sent.filter((email) => email.to === booked.appointment.invitee.email)).toHaveLength(0);
    // Due: the first send fails and is retried by the next run.
    await run(Date.parse('2027-01-09T12:00:00Z'), () =>
      Promise.reject(new Error('smtp down')),
    ).catch(() => undefined);
    await run(Date.parse('2027-01-09T12:05:00Z'));
    await run(Date.parse('2027-01-09T12:10:00Z'));
    const mine = sent.filter((email) => email.to === booked.appointment.invitee.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({
      title: 'Site visit',
      when: 'Sun, 10 Jan 2027, 10:00 (Asia/Bahrain)',
      organization: A().name,
    });
    const token = mine[0]?.data.manageUrl?.split('/book/manage/')[1] ?? '';
    expect(mine[0]?.data.manageUrl).toBe(`https://app.example.com/book/manage/${token}`);
    expect(await resolveManageToken(handle.db, token, NOW)).toMatchObject({
      appointmentId: booked.appointment.id,
    });
    // Rescheduling makes a new reminder due.
    await rescheduleAppointment(
      handle.db,
      services,
      ctxFor(A(), null),
      booked.appointment.id,
      { startsAt: '2027-01-12T07:00:00.000Z' },
      'invitee',
      Date.parse('2027-01-09T12:20:00Z'),
    );
    await run(Date.parse('2027-01-11T12:00:00Z'));
    expect(sent.filter((email) => email.to === booked.appointment.invitee.email)).toHaveLength(2);
  });

  it('skips late bookings and cancelled appointments', async () => {
    const { book } = await setup();
    // Booked two hours before the start: the confirmation is enough.
    const late = await book('2027-01-10T08:00:00.000Z', Date.parse('2027-01-10T06:00:00Z'));
    const cancelled = await book('2027-01-10T09:00:00.000Z');
    await inOrg(A(), (tx, ctx) =>
      cancelAppointment(tx, ctx, cancelled.appointment.id, {}, 'staff'),
    );
    const sent: AppointmentEmail[] = [];
    await processDueReminders(handle.db, {
      now: Date.parse('2027-01-10T06:30:00Z'),
      appUrl: 'https://app.example.com',
      send: (email) => {
        sent.push(email);
        return Promise.resolve();
      },
    });
    const recipients = sent.map((email) => email.to);
    expect(recipients).not.toContain(late.appointment.invitee.email);
    expect(recipients).not.toContain(cancelled.appointment.invitee.email);
  });
});

describe('external calendar sync', () => {
  it('creates, moves and removes the mirrored event idempotently', async () => {
    const { book } = await setup({ connect: true });
    const booked = await book('2027-01-10T07:00:00.000Z');
    const id = booked.appointment.id;
    expect(await syncAppointmentEvents(handle.db, services, A().id, id)).toEqual({
      created: 1,
      cancelled: 0,
      failed: 0,
    });
    // A second run changes nothing.
    expect(await syncAppointmentEvents(handle.db, services, A().id, id)).toEqual({
      created: 0,
      cancelled: 0,
      failed: 0,
    });
    const [withLink] = await inOrg(A(), (tx) =>
      tx.select().from(appointments).where(eq(appointments.id, id)),
    );
    expect(withLink?.joinUrl).toBe(`https://meet.example.test/${id}`);
    expect(fake.events.get(`fake_evt_${id}`)).toMatchObject({ title: 'Site visit' });

    // A provider outage is recorded and retried by the job.
    await rescheduleAppointment(
      handle.db,
      services,
      ctxFor(A(), null),
      id,
      { startsAt: '2027-01-11T07:00:00.000Z' },
      'staff',
      NOW,
    );
    fake.failNext();
    await expect(syncAppointmentEvents(handle.db, services, A().id, id)).rejects.toThrow();
    expect(await syncAppointmentEvents(handle.db, services, A().id, id)).toMatchObject({
      created: 1,
      failed: 0,
    });
    expect(fake.events.get(`fake_evt_${id}`)?.start).toBe(Date.parse('2027-01-11T07:00:00Z'));

    await inOrg(A(), (tx, ctx) => cancelAppointment(tx, ctx, id, {}, 'staff'));
    expect(await syncAppointmentEvents(handle.db, services, A().id, id)).toMatchObject({
      cancelled: 1,
    });
    expect(fake.events.has(`fake_evt_${id}`)).toBe(false);
    const [record] = await inOrg(A(), (tx) =>
      tx
        .select()
        .from(appointmentExternalEvents)
        .where(and(eq(appointmentExternalEvents.appointmentId, id))),
    );
    expect(record?.status).toBe('cancelled');
  });
});

describe('timeline', () => {
  it('projects bookings and cancellations onto the contact timeline', async () => {
    const { book } = await setup();
    const booked = await book('2027-01-10T07:00:00.000Z');
    await inOrg(A(), (tx, ctx) => cancelAppointment(tx, ctx, booked.appointment.id, {}, 'staff'));
    const eventIds = await withSystem(handle.db, (tx) =>
      tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.subjectId, booked.appointment.id)),
    );
    for (const { id } of eventIds) {
      const event = await loadEvent(handle.db, id);
      if (event) await projectEvent(handle.db, calendarTimelineProjectors, event);
    }
    const contactId = booked.appointment.contact?.id ?? '';
    const timeline = await withTenant(
      handle.db,
      { organizationId: A().id, userId: world.orgA.users.restricted.id },
      (tx) =>
        listActivities(
          tx,
          A().id,
          { kind: 'contact', id: contactId },
          { limit: 10 },
          new Set(['calendar.appointment.read', 'crm.contact.read']),
        ),
    );
    expect(timeline.data.map((activity) => activity.summary)).toEqual([
      'Site visit on Sun, 10 Jan 2027, 10:00 (Asia/Bahrain) cancelled',
      'Booked Site visit for Sun, 10 Jan 2027, 10:00 (Asia/Bahrain)',
    ]);
  });
});
