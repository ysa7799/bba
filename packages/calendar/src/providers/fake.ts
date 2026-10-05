import type { Interval } from '../availability';
import {
  CalendarProviderError,
  type CalendarProvider,
  type ExternalEventInput,
  type ResolvedCalendarConnection,
} from './types';

/** Development/test calendar: busy times are set by tests; events are recorded in memory. */
export class FakeCalendarProvider implements CalendarProvider {
  readonly key = 'fake_calendar';
  readonly label = 'Test calendar (development)';
  readonly credentialFields = [] as const;
  readonly events = new Map<string, ExternalEventInput & { connectionId: string }>();
  private readonly busy = new Map<string, Interval[]>();
  private failures = 0;

  setBusy(externalCalendarId: string, intervals: Interval[]): void {
    this.busy.set(externalCalendarId, intervals);
  }

  /** Makes the next calls fail with a retryable error (tests). */
  failNext(count = 1): void {
    this.failures += count;
  }

  private maybeFail(): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new CalendarProviderError(this.key, 'Simulated calendar outage', { retryable: true });
    }
  }

  busyTimes(connection: ResolvedCalendarConnection, range: Interval): Promise<Interval[]> {
    this.maybeFail();
    return Promise.resolve(
      (this.busy.get(connection.externalCalendarId) ?? []).filter(
        (interval) => interval.start < range.end && range.start < interval.end,
      ),
    );
  }

  createEvent(
    connection: ResolvedCalendarConnection,
    event: ExternalEventInput,
  ): Promise<{ externalEventId: string; joinUrl: string | null }> {
    this.maybeFail();
    const externalEventId = `fake_evt_${event.appointmentId}`;
    this.events.set(externalEventId, { ...event, connectionId: connection.id });
    return Promise.resolve({
      externalEventId,
      joinUrl: event.addVideoMeeting ? `https://meet.example.test/${event.appointmentId}` : null,
    });
  }

  cancelEvent(_connection: ResolvedCalendarConnection, externalEventId: string): Promise<void> {
    this.maybeFail();
    this.events.delete(externalEventId);
    return Promise.resolve();
  }
}
