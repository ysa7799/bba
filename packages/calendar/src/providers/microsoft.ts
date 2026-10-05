import { z } from 'zod';
import type { Interval } from '../availability';
import { providerRequest, requireToken, type HttpOptions } from './http';
import {
  CalendarProviderError,
  type CalendarProvider,
  type ExternalEventInput,
  type ResolvedCalendarConnection,
} from './types';

const scheduleSchema = z.object({
  value: z.array(
    z.object({
      scheduleId: z.string().optional(),
      error: z.object({ message: z.string().optional() }).nullable().optional(),
      scheduleItems: z
        .array(
          z.object({
            status: z.string(),
            start: z.object({ dateTime: z.string() }),
            end: z.object({ dateTime: z.string() }),
          }),
        )
        .default([]),
    }),
  ),
});

const eventSchema = z.object({
  id: z.string().min(1),
  onlineMeeting: z.object({ joinUrl: z.url().optional() }).nullable().optional(),
});

/** Graph returns `dateTime` without an offset in the requested zone (UTC here). */
function utc(dateTime: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`);
}

const BUSY_STATUSES = new Set(['busy', 'oof', 'tentative', 'workingElsewhere']);

/**
 * Microsoft 365 / Outlook calendars through Microsoft Graph v1.0 with an OAuth access token.
 * Busy times via `getSchedule`; bookings become events (Teams meeting for video appointments),
 * created with the appointment id as `transactionId` so a retried request cannot duplicate.
 * Live status: CONFIGURATION_REQUIRED — tokens come from the OAuth integrations framework.
 */
export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly key = 'microsoft_calendar';
  readonly label = 'Microsoft 365 Calendar';
  readonly credentialFields = [{ key: 'accessToken', label: 'OAuth access token', secret: true }];

  constructor(private readonly options: HttpOptions = {}) {}

  private url(path: string): string {
    return `${this.options.baseUrl ?? 'https://graph.microsoft.com/v1.0'}${path}`;
  }

  async busyTimes(connection: ResolvedCalendarConnection, range: Interval): Promise<Interval[]> {
    const token = requireToken(this.key, connection.credentials);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/Z$/, '');
    const { body } = await providerRequest(
      this.key,
      this.options,
      this.url('/me/calendar/getSchedule'),
      {
        method: 'POST',
        token,
        body: {
          schedules: [connection.externalCalendarId],
          startTime: { dateTime: iso(range.start), timeZone: 'UTC' },
          endTime: { dateTime: iso(range.end), timeZone: 'UTC' },
          availabilityViewInterval: 15,
        },
      },
    );
    const parsed = scheduleSchema.safeParse(body);
    const schedule = parsed.success ? parsed.data.value[0] : undefined;
    if (!schedule || schedule.error) {
      throw new CalendarProviderError(this.key, 'Microsoft calendar busy times unavailable', {
        retryable: true,
      });
    }
    return schedule.scheduleItems
      .filter((item) => BUSY_STATUSES.has(item.status))
      .map((item) => ({ start: utc(item.start.dateTime), end: utc(item.end.dateTime) }));
  }

  async createEvent(
    connection: ResolvedCalendarConnection,
    event: ExternalEventInput,
  ): Promise<{ externalEventId: string; joinUrl: string | null }> {
    const token = requireToken(this.key, connection.credentials);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/Z$/, '');
    const { body } = await providerRequest(this.key, this.options, this.url('/me/events'), {
      method: 'POST',
      token,
      body: {
        subject: event.title,
        body: { contentType: 'text', content: event.description },
        start: { dateTime: iso(event.start), timeZone: 'UTC' },
        end: { dateTime: iso(event.end), timeZone: 'UTC' },
        attendees: event.attendees.map((attendee) => ({
          emailAddress: { address: attendee.email, name: attendee.name ?? attendee.email },
          type: 'required',
        })),
        transactionId: event.appointmentId,
        ...(event.addVideoMeeting
          ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
          : {}),
      },
    });
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) {
      throw new CalendarProviderError(this.key, 'Unexpected Microsoft Graph response', {
        retryable: false,
      });
    }
    return {
      externalEventId: parsed.data.id,
      joinUrl: parsed.data.onlineMeeting?.joinUrl ?? null,
    };
  }

  async cancelEvent(
    connection: ResolvedCalendarConnection,
    externalEventId: string,
  ): Promise<void> {
    const token = requireToken(this.key, connection.credentials);
    await providerRequest(
      this.key,
      this.options,
      this.url(`/me/events/${encodeURIComponent(externalEventId)}`),
      { method: 'DELETE', token, allowStatuses: [404] },
    );
  }
}
