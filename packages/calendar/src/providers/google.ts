import { z } from 'zod';
import type { Interval } from '../availability';
import { providerRequest, requireToken, type HttpOptions } from './http';
import {
  CalendarProviderError,
  type CalendarProvider,
  type ExternalEventInput,
  type ResolvedCalendarConnection,
} from './types';

const freeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
      errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    }),
  ),
});

const eventSchema = z.object({
  id: z.string().min(1),
  hangoutLink: z.url().optional(),
});

/**
 * Google Calendar (API v3) with an OAuth access token. Busy times via `freeBusy`; bookings
 * become events (with a Google Meet link for video appointments via `conferenceData`).
 * Live status: CONFIGURATION_REQUIRED — tokens come from the OAuth integrations framework.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly key = 'google_calendar';
  readonly label = 'Google Calendar';
  readonly credentialFields = [{ key: 'accessToken', label: 'OAuth access token', secret: true }];

  constructor(private readonly options: HttpOptions = {}) {}

  private url(path: string): string {
    return `${this.options.baseUrl ?? 'https://www.googleapis.com/calendar/v3'}${path}`;
  }

  async busyTimes(connection: ResolvedCalendarConnection, range: Interval): Promise<Interval[]> {
    const token = requireToken(this.key, connection.credentials);
    const { body } = await providerRequest(this.key, this.options, this.url('/freeBusy'), {
      method: 'POST',
      token,
      body: {
        timeMin: new Date(range.start).toISOString(),
        timeMax: new Date(range.end).toISOString(),
        items: [{ id: connection.externalCalendarId }],
      },
    });
    const parsed = freeBusySchema.safeParse(body);
    const calendar = parsed.success ? parsed.data.calendars[connection.externalCalendarId] : null;
    if (!calendar || (calendar.errors && calendar.errors.length > 0)) {
      // An unreadable calendar must not look free.
      throw new CalendarProviderError(this.key, 'Google Calendar busy times unavailable', {
        retryable: true,
      });
    }
    return calendar.busy.map((entry) => ({
      start: Date.parse(entry.start),
      end: Date.parse(entry.end),
    }));
  }

  async createEvent(
    connection: ResolvedCalendarConnection,
    event: ExternalEventInput,
  ): Promise<{ externalEventId: string; joinUrl: string | null }> {
    const token = requireToken(this.key, connection.credentials);
    const calendarId = encodeURIComponent(connection.externalCalendarId);
    const { body } = await providerRequest(
      this.key,
      this.options,
      this.url(`/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=none`),
      {
        method: 'POST',
        token,
        body: {
          summary: event.title,
          description: event.description,
          start: { dateTime: new Date(event.start).toISOString(), timeZone: event.timeZone },
          end: { dateTime: new Date(event.end).toISOString(), timeZone: event.timeZone },
          attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            ...(attendee.name ? { displayName: attendee.name } : {}),
          })),
          ...(event.addVideoMeeting
            ? {
                conferenceData: {
                  createRequest: {
                    requestId: event.appointmentId,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
              }
            : {}),
        },
      },
    );
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) {
      throw new CalendarProviderError(this.key, 'Unexpected Google Calendar response', {
        retryable: false,
      });
    }
    return { externalEventId: parsed.data.id, joinUrl: parsed.data.hangoutLink ?? null };
  }

  async cancelEvent(
    connection: ResolvedCalendarConnection,
    externalEventId: string,
  ): Promise<void> {
    const token = requireToken(this.key, connection.credentials);
    const calendarId = encodeURIComponent(connection.externalCalendarId);
    // Already gone (404/410) counts as cancelled.
    await providerRequest(
      this.key,
      this.options,
      this.url(
        `/calendars/${calendarId}/events/${encodeURIComponent(externalEventId)}?sendUpdates=none`,
      ),
      { method: 'DELETE', token, allowStatuses: [404, 410] },
    );
  }
}
