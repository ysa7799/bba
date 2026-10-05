import type { Interval } from '../availability';

/**
 * External calendar a host connects (Google Calendar, Microsoft 365). Used to read busy times
 * into availability and to mirror bookings as events. Credentials are sealed per connection;
 * adapters only ever see the decrypted view inside the server.
 */
export interface ResolvedCalendarConnection {
  id: string;
  organizationId: string;
  /** Our calendar the connection belongs to. */
  calendarId: string;
  provider: string;
  /** Provider calendar id (e.g. `primary` or an email address). */
  externalCalendarId: string;
  credentials: Record<string, string>;
}

export interface ExternalEventInput {
  /** Our appointment id (idempotency key at the provider when supported). */
  appointmentId: string;
  title: string;
  description: string;
  start: number;
  end: number;
  timeZone: string;
  attendees: { email: string; name: string | null }[];
  /** Ask the provider to attach a video meeting (Google Meet) when it supports it. */
  addVideoMeeting: boolean;
}

export interface CalendarProvider {
  readonly key: string;
  readonly label: string;
  readonly credentialFields: readonly { key: string; label: string; secret: boolean }[];
  busyTimes(connection: ResolvedCalendarConnection, range: Interval): Promise<Interval[]>;
  createEvent(
    connection: ResolvedCalendarConnection,
    event: ExternalEventInput,
  ): Promise<{ externalEventId: string; joinUrl: string | null }>;
  cancelEvent(connection: ResolvedCalendarConnection, externalEventId: string): Promise<void>;
}

/** Provider failure; `retryable` separates outages/rate limits from permanent rejections. */
export class CalendarProviderError extends Error {
  readonly retryable: boolean;
  readonly providerCode: string | null;

  constructor(
    readonly provider: string,
    message: string,
    options: { retryable: boolean; providerCode?: string | null },
  ) {
    super(message);
    this.name = 'CalendarProviderError';
    this.retryable = options.retryable;
    this.providerCode = options.providerCode ?? null;
  }
}
