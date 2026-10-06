import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

const cal = (orgId: string, path: string) => `/app/orgs/${orgId}/calendar${path}`;

/** 10:00 Asia/Bahrain on a Sunday–Thursday at least three days from now (real clock). */
function workdaySlot(daysAhead = 3): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + daysAhead);
  while (day.getUTCDay() > 4) day.setUTCDate(day.getUTCDate() + 1);
  return `${day.toISOString().slice(0, 10)}T07:00:00.000Z`;
}

/** A day later (two `workdaySlot` calls can land on the same day across a weekend). */
function dayAfter(iso: string): string {
  return new Date(Date.parse(iso) + 86_400_000).toISOString();
}

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

async function bookingSetup(orgId = A, admin = world.orgA.users.owner) {
  const client = await as(admin);
  const calendar = (
    await client.post(cal(orgId, '/calendars'), { name: `Clinic room ${uniqueSuffix()}` })
  ).json().calendar;
  const typeResponse = await client.post(cal(orgId, '/appointment-types'), {
    name: 'Consultation',
    durationMinutes: 30,
    hostCalendarIds: [calendar.id],
    minimumNoticeMinutes: 60,
  });
  expect(typeResponse.statusCode).toBe(201);
  const type = typeResponse.json().appointmentType;
  const pageResponse = await client.post(cal(orgId, '/booking-pages'), {
    title: 'Book a consultation',
    slug: `clinic-${uniqueSuffix()}`.toLowerCase(),
    appointmentTypeIds: [type.id],
  });
  expect(pageResponse.statusCode).toBe(201);
  return { client, calendar, type, page: pageResponse.json().bookingPage };
}

const invitee = () => ({
  name: 'Noor Ahmed',
  email: `noor.${uniqueSuffix()}@example.com`,
  timezone: 'Asia/Bahrain',
});

describe('scheduling configuration permissions', () => {
  it('lets admins configure scheduling and members manage only their own availability', async () => {
    const { calendar } = await bookingSetup();
    const sales = await as(world.orgA.users.sales);
    expect(
      (
        await sales.post(cal(A, '/appointment-types'), {
          name: 'x',
          durationMinutes: 30,
          hostCalendarIds: [calendar.id],
        })
      ).statusCode,
    ).toBe(403);
    expect((await sales.post(cal(A, '/booking-pages'), { title: 'x' })).statusCode).toBe(403);
    expect((await sales.post(cal(A, '/calendars'), { name: 'x' })).statusCode).toBe(403);

    const mine = (await sales.post(cal(A, '/calendars/me'), {})).json().calendar;
    expect(mine).toMatchObject({ kind: 'user', timezone: 'Asia/Bahrain' });
    expect((await sales.post(cal(A, '/calendars/me'), {})).json().calendar.id).toBe(mine.id);
    const rules = { rules: [{ weekday: 0, startMinute: 600, endMinute: 900 }] };
    const ownEdit = await sales.request('PUT', cal(A, `/calendars/${mine.id}/availability`), rules);
    expect(ownEdit.statusCode).toBe(200);
    expect(ownEdit.json().availability.rules).toEqual([
      { weekday: 0, startMinute: 600, endMinute: 900 },
    ]);
    expect(
      (await sales.request('PUT', cal(A, `/calendars/${calendar.id}/availability`), rules))
        .statusCode,
    ).toBe(403);
    // Members cannot deactivate even their own calendar.
    expect(
      (await sales.patch(cal(A, `/calendars/${mine.id}`), { isActive: false })).statusCode,
    ).toBe(403);
    expect(
      (await sales.patch(cal(A, `/calendars/${mine.id}`), { name: 'Sales desk' })).json().calendar
        .name,
    ).toBe('Sales desk');

    // Restricted members can look but not book.
    const restricted = await as(world.orgA.users.restricted);
    expect((await restricted.get(cal(A, '/appointments'))).statusCode).toBe(200);
    expect(
      (
        await restricted.post(cal(A, '/appointments'), {
          calendarId: calendar.id,
          title: 'x',
          durationMinutes: 30,
          startsAt: workdaySlot(),
        })
      ).statusCode,
    ).toBe(403);
    expect((await restricted.post(cal(A, '/calendars/me'), {})).statusCode).toBe(403);

    const audit = (
      await (
        await as(world.orgA.users.owner)
      ).get(`/app/orgs/${A}/audit-logs?action=calendar.booking_page.created`)
    ).json().data;
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('public booking', () => {
  it('books through a public page, emails the invitee and supports self-service changes', async () => {
    const { client, type, page } = await bookingSetup();
    const anonymous = ctx.app;
    const info = await anonymous.inject({
      method: 'GET',
      url: `/public/booking/pages/${page.slug}`,
    });
    expect(info.statusCode).toBe(200);
    expect(info.headers['cache-control']).toBe('no-store');
    expect(info.json()).toMatchObject({
      page: { title: 'Book a consultation' },
      organization: { timezone: 'Asia/Bahrain' },
      appointmentTypes: [{ id: type.id, durationMinutes: 30 }],
    });
    const startsAt = workdaySlot();
    const dayEnd = new Date(Date.parse(startsAt) + 86_400_000).toISOString();
    const slots = await anonymous.inject({
      method: 'GET',
      url: `/public/booking/pages/${page.slug}/types/${type.id}/slots?from=${encodeURIComponent(startsAt)}&to=${encodeURIComponent(dayEnd)}`,
    });
    expect(slots.json().data[0]).toBe(startsAt);
    expect(JSON.stringify(slots.json())).not.toContain('calendarIds');

    // Bots that fill the hidden field are refused.
    const bot = await anonymous.inject({
      method: 'POST',
      url: `/public/booking/pages/${page.slug}/book`,
      payload: {
        appointmentTypeId: type.id,
        startsAt,
        invitee: invitee(),
        website: 'spam.example',
      },
    });
    expect(bot.statusCode).toBe(400);

    const person = invitee();
    const booked = await anonymous.inject({
      method: 'POST',
      url: `/public/booking/pages/${page.slug}/book`,
      payload: { appointmentTypeId: type.id, startsAt, invitee: person },
    });
    expect(booked.statusCode).toBe(201);
    const { appointment, manageToken } = booked.json();
    expect(appointment).toMatchObject({ status: 'scheduled', startsAt, canChange: true });
    expect(appointment).not.toHaveProperty('inviteeEmail');
    const confirmation = ctx.jobs
      .ofType('email.send')
      .find(
        (job) =>
          job.payload.to === person.email && job.payload.template === 'appointment_confirmed',
      );
    expect(confirmation?.payload.data.manageUrl).toContain(`/book/manage/${manageToken}`);
    expect(
      ctx.jobs.ofType('calendar.sync').some((job) => job.payload.appointmentId === appointment.id),
    ).toBe(true);

    // The same slot cannot be booked twice.
    const again = await anonymous.inject({
      method: 'POST',
      url: `/public/booking/pages/${page.slug}/book`,
      payload: { appointmentTypeId: type.id, startsAt, invitee: invitee() },
    });
    expect(again.statusCode).toBe(409);

    // Staff see the booking with the new contact.
    const listed = (
      await client.get(cal(A, `/appointments?status=all&from=${encodeURIComponent(startsAt)}`))
    ).json().data;
    expect(listed.find((row: { id: string }) => row.id === appointment.id)).toMatchObject({
      contact: { name: 'Noor Ahmed' },
      invitee: { email: person.email },
      source: 'booking_page',
    });

    // Self-service: reschedule (new link emailed), then cancel.
    const manage = `/public/booking/manage/${manageToken}`;
    expect((await anonymous.inject({ method: 'GET', url: manage })).json().appointment.id).toBe(
      appointment.id,
    );
    const later = new Date(Date.parse(startsAt) + 3_600_000).toISOString();
    const moved = await anonymous.inject({
      method: 'POST',
      url: `${manage}/reschedule`,
      payload: { startsAt: later },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().appointment.startsAt).toBe(later);
    expect(
      ctx.jobs
        .ofType('email.send')
        .some(
          (job) =>
            job.payload.to === person.email && job.payload.template === 'appointment_rescheduled',
        ),
    ).toBe(true);
    const cancelled = await anonymous.inject({
      method: 'POST',
      url: `${manage}/cancel`,
      payload: { reason: 'Travelling' },
    });
    expect(cancelled.json().appointment).toMatchObject({ status: 'cancelled', canChange: false });
    expect(
      (await anonymous.inject({ method: 'POST', url: `${manage}/cancel`, payload: {} })).statusCode,
    ).toBe(409);
    expect(
      (
        await anonymous.inject({
          method: 'GET',
          url: `/public/booking/manage/${'x'.repeat(43)}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('never exposes inactive pages, other organizations’ types or private data', async () => {
    const { type, page, client } = await bookingSetup();
    const other = await bookingSetup(B, world.orgB.users.admin);
    const slotsUrl = (slug: string, typeId: string) =>
      `/public/booking/pages/${slug}/types/${typeId}/slots?from=${encodeURIComponent(workdaySlot())}&to=${encodeURIComponent(dayAfter(workdaySlot()))}`;
    // A's type through B's page.
    expect(
      (await ctx.app.inject({ method: 'GET', url: slotsUrl(other.page.slug, type.id) })).statusCode,
    ).toBe(404);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/public/booking/pages/${other.page.slug}/book`,
          payload: { appointmentTypeId: type.id, startsAt: workdaySlot(), invitee: invitee() },
        })
      ).statusCode,
    ).toBe(404);
    await client.patch(cal(A, `/booking-pages/${page.id}`), { isActive: false });
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/public/booking/pages/${page.slug}` }))
        .statusCode,
    ).toBe(404);
  });
});

describe('invitee changes', () => {
  it('allow only future appointments of types that are still offered', async () => {
    const { client, calendar, type, page } = await bookingSetup();
    const manageToken = (email: string) =>
      (
        ctx.jobs.ofType('email.send').findLast((job) => job.payload.to === email)?.payload.data
          .manageUrl ?? ''
      ).split('/book/manage/')[1] ?? '';

    // Started an hour ago (booked by staff): the emailed link can no longer change it.
    const late = invitee();
    const walkIn = await client.post(cal(A, '/appointments'), {
      calendarId: calendar.id,
      title: 'Walk-in',
      durationMinutes: 120,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      invitee: { email: late.email, name: late.name },
    });
    expect(walkIn.statusCode).toBe(201);
    const pastLink = `/public/booking/manage/${manageToken(late.email)}`;
    expect(
      (await ctx.app.inject({ method: 'GET', url: pastLink })).json().appointment.canChange,
    ).toBe(false);
    for (const action of ['cancel', 'reschedule']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${pastLink}/${action}`,
        payload: action === 'cancel' ? {} : { startsAt: workdaySlot() },
      });
      expect(response.statusCode, action).toBe(409);
    }

    // A deactivated type: no online rescheduling (cancelling is still possible).
    const person = invitee();
    const booked = await ctx.app.inject({
      method: 'POST',
      url: `/public/booking/pages/${page.slug}/book`,
      payload: { appointmentTypeId: type.id, startsAt: workdaySlot(), invitee: person },
    });
    expect(booked.statusCode).toBe(201);
    await client.patch(cal(A, `/appointment-types/${type.id}`), { isActive: false });
    const link = `/public/booking/manage/${booked.json().manageToken}`;
    const later = new Date(Date.parse(workdaySlot()) + 3_600_000).toISOString();
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `${link}/reschedule`,
          payload: { startsAt: later },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await ctx.app.inject({ method: 'POST', url: `${link}/cancel`, payload: {} })).statusCode,
    ).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('returns 404 for another organization’s scheduling records', async () => {
    const { calendar, type, page, client } = await bookingSetup();
    const booked = await client.post(cal(A, '/appointments'), {
      calendarId: calendar.id,
      title: 'Internal review',
      durationMinutes: 30,
      startsAt: workdaySlot(5),
    });
    expect(booked.statusCode).toBe(201);
    const appointmentId = booked.json().appointment.id;
    const bAdmin = await as(world.orgB.users.admin);
    for (const [method, path, body] of [
      ['GET', `/appointments/${appointmentId}`, undefined],
      ['POST', `/appointments/${appointmentId}/cancel`, {}],
      ['POST', `/appointments/${appointmentId}/reschedule`, { startsAt: workdaySlot(6) }],
      ['POST', `/appointments/${appointmentId}/status`, { status: 'completed' }],
      ['GET', `/calendars/${calendar.id}`, undefined],
      ['GET', `/calendars/${calendar.id}/availability`, undefined],
      ['PUT', `/calendars/${calendar.id}/availability`, { rules: [] }],
      ['GET', `/appointment-types/${type.id}`, undefined],
      ['PATCH', `/appointment-types/${type.id}`, { name: 'Hijack' }],
      [
        'GET',
        `/appointment-types/${type.id}/slots?from=${encodeURIComponent(workdaySlot())}&to=${encodeURIComponent(dayAfter(workdaySlot()))}`,
        undefined,
      ],
      ['GET', `/booking-pages/${page.id}`, undefined],
      ['PATCH', `/booking-pages/${page.id}`, { title: 'Hijack' }],
      ['DELETE', `/booking-pages/${page.id}`, undefined],
    ] as const) {
      expect(
        (await bAdmin.request(method, cal(B, path), body)).statusCode,
        `${method} ${path}`,
      ).toBe(404);
    }
    const bList = (await bAdmin.get(cal(B, '/appointments?status=all&limit=200'))).json().data;
    expect(JSON.stringify(bList)).not.toContain(appointmentId);
    // Hosts and contacts must belong to the caller's organization.
    expect(
      (
        await bAdmin.post(cal(B, '/appointments'), {
          calendarId: calendar.id,
          title: 'x',
          durationMinutes: 30,
          startsAt: workdaySlot(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await bAdmin.post(cal(B, '/appointment-types'), {
          name: 'x',
          durationMinutes: 30,
          hostCalendarIds: [calendar.id],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('logging', () => {
  it('never writes manage-link tokens to the logs', async () => {
    const lines: string[] = [];
    const logged = await createTestContext({
      env: { LOG_LEVEL: 'info' },
      logStream: { write: (line) => void lines.push(line) },
    });
    try {
      const token = 'Z'.repeat(43);
      await logged.app.inject({ method: 'GET', url: `/public/booking/manage/${token}` });
      const output = lines.join('');
      expect(output).toContain('/public/booking/manage/[REDACTED]');
      expect(output).not.toContain(token);
    } finally {
      await logged.close();
    }
  });
});
