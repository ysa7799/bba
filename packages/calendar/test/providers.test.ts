import { describe, expect, it, vi } from 'vitest';
import {
  CalendarProviderError,
  createCalendarProviders,
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
  type ResolvedCalendarConnection,
} from '../src';

const connection = (
  externalCalendarId: string,
  accessToken = 'ya29.token',
): ResolvedCalendarConnection => ({
  id: 'conn-1',
  organizationId: 'org-1',
  calendarId: 'cal-1',
  provider: 'x',
  externalCalendarId,
  credentials: accessToken ? { accessToken } : {},
});

/** JSON body a mocked fetch was called with. */
function sentBody(init: RequestInit | undefined): unknown {
  return JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown;
}

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

const range = {
  start: Date.parse('2027-01-10T00:00:00Z'),
  end: Date.parse('2027-01-11T00:00:00Z'),
};
const event = {
  appointmentId: '0193a000-0000-7000-8000-000000000001',
  title: 'Site visit',
  description: 'Fatima',
  start: Date.parse('2027-01-10T07:00:00Z'),
  end: Date.parse('2027-01-10T07:30:00Z'),
  timeZone: 'Asia/Bahrain',
  attendees: [{ email: 'fatima@example.com', name: 'Fatima' }],
  addVideoMeeting: true,
};

describe('Google Calendar adapter', () => {
  it('reads free/busy and creates events with a Meet link', async () => {
    const fetch = mockFetch(200, {
      calendars: {
        primary: { busy: [{ start: '2027-01-10T09:00:00Z', end: '2027-01-10T10:00:00Z' }] },
      },
    });
    const google = new GoogleCalendarProvider({ fetch });
    expect(await google.busyTimes(connection('primary'), range)).toEqual([
      { start: Date.parse('2027-01-10T09:00:00Z'), end: Date.parse('2027-01-10T10:00:00Z') },
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    expect(sentBody(init)).toEqual({
      timeMin: '2027-01-10T00:00:00.000Z',
      timeMax: '2027-01-11T00:00:00.000Z',
      items: [{ id: 'primary' }],
    });

    const create = mockFetch(200, {
      id: 'evt123',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });
    const created = await new GoogleCalendarProvider({ fetch: create }).createEvent(
      connection('team@example.com'),
      event,
    );
    expect(created).toEqual({
      externalEventId: 'evt123',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    });
    const [createUrl, createInit] = create.mock.calls[0] ?? [];
    expect(createUrl).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/team%40example.com/events?conferenceDataVersion=1&sendUpdates=none',
    );
    expect(sentBody(createInit)).toMatchObject({
      summary: 'Site visit',
      start: { dateTime: '2027-01-10T07:00:00.000Z', timeZone: 'Asia/Bahrain' },
      attendees: [{ email: 'fatima@example.com', displayName: 'Fatima' }],
      conferenceData: { createRequest: { requestId: event.appointmentId } },
    });
  });

  it('treats unreadable calendars as unavailable and classifies errors', async () => {
    const google = (status: number, body: unknown) =>
      new GoogleCalendarProvider({ fetch: mockFetch(status, body) });
    await expect(
      google(200, { calendars: { primary: { errors: [{ reason: 'notFound' }] } } }).busyTimes(
        connection('primary'),
        range,
      ),
    ).rejects.toMatchObject({ retryable: true });
    await expect(google(401, {}).busyTimes(connection('primary'), range)).rejects.toMatchObject({
      retryable: false,
      providerCode: 'unauthorized',
    });
    await expect(google(503, {}).busyTimes(connection('primary'), range)).rejects.toMatchObject({
      retryable: true,
    });
    await expect(google(400, {}).createEvent(connection('primary'), event)).rejects.toMatchObject({
      retryable: false,
    });
    // Deleting an event that is already gone succeeds.
    await expect(
      google(410, null).cancelEvent(connection('primary'), 'evt'),
    ).resolves.toBeUndefined();
    // No token: configuration required, without calling the provider.
    const fetch = mockFetch(200, {});
    await expect(
      new GoogleCalendarProvider({ fetch }).busyTimes(connection('primary', ''), range),
    ).rejects.toMatchObject({ providerCode: 'configuration_required' });
    expect(fetch).not.toHaveBeenCalled();
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      new GoogleCalendarProvider({ fetch: offline }).busyTimes(connection('primary'), range),
    ).rejects.toBeInstanceOf(CalendarProviderError);
  });
});

describe('Microsoft 365 adapter', () => {
  it('reads busy schedule items in UTC and creates idempotent events', async () => {
    const fetch = mockFetch(200, {
      value: [
        {
          scheduleId: 'ali@example.com',
          scheduleItems: [
            {
              status: 'busy',
              start: { dateTime: '2027-01-10T09:00:00.0000000' },
              end: { dateTime: '2027-01-10T10:00:00.0000000' },
            },
            {
              status: 'free',
              start: { dateTime: '2027-01-10T11:00:00.0000000' },
              end: { dateTime: '2027-01-10T12:00:00.0000000' },
            },
          ],
        },
      ],
    });
    const microsoft = new MicrosoftCalendarProvider({ fetch });
    expect(await microsoft.busyTimes(connection('ali@example.com'), range)).toEqual([
      { start: Date.parse('2027-01-10T09:00:00Z'), end: Date.parse('2027-01-10T10:00:00Z') },
    ]);
    expect(sentBody(fetch.mock.calls[0]?.[1])).toMatchObject({
      schedules: ['ali@example.com'],
      startTime: { dateTime: '2027-01-10T00:00:00.000', timeZone: 'UTC' },
    });
    const create = mockFetch(201, {
      id: 'AAMk',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
    });
    expect(
      await new MicrosoftCalendarProvider({ fetch: create }).createEvent(connection('me'), event),
    ).toEqual({ externalEventId: 'AAMk', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' });
    expect(sentBody(create.mock.calls[0]?.[1])).toMatchObject({
      transactionId: event.appointmentId,
      isOnlineMeeting: true,
      start: { dateTime: '2027-01-10T07:00:00.000', timeZone: 'UTC' },
    });
    await expect(
      new MicrosoftCalendarProvider({
        fetch: mockFetch(200, { value: [{ error: { message: 'x' } }] }),
      }).busyTimes(connection('ali@example.com'), range),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('provider registry', () => {
  it('registers the fake calendar only when enabled', () => {
    expect(
      createCalendarProviders({ fake: false })
        .list()
        .map((p) => p.key),
    ).toEqual(['google_calendar', 'microsoft_calendar']);
    expect(createCalendarProviders({ fake: true }).get('fake_calendar')).toBeDefined();
  });
});
