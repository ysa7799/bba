// Response shapes of `/app/orgs/:orgId/calendar/*` and `/public/booking/*`.

export type SchedulingMode = 'individual' | 'round_robin' | 'collective';
export type LocationKind = 'in_person' | 'phone' | 'video' | 'custom';
export type AppointmentStatus = 'scheduled' | 'cancelled' | 'completed' | 'no_show';

export interface CalendarSummary {
  id: string;
  kind: 'user' | 'resource';
  name: string;
  timezone: string;
  isActive: boolean;
  user: { id: string; name: string } | null;
}

export interface WeeklyRule {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface AvailabilityException {
  id: string;
  date: string;
  kind: 'available' | 'unavailable';
  startMinute: number | null;
  endMinute: number | null;
  reason: string | null;
}

export interface Availability {
  calendarId: string;
  timezone: string;
  rules: WeeklyRule[];
  exceptions: AvailabilityException[];
}

export interface AppointmentTypeSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
  schedulingMode: SchedulingMode;
  locationKind: LocationKind;
  locationDetails: string | null;
  isActive: boolean;
  hosts: { calendarId: string; name: string }[];
}

export interface BookingPageSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  isActive: boolean;
  appointmentTypes: { id: string; name: string; isActive: boolean }[];
}

export interface AppointmentSummary {
  id: string;
  title: string;
  status: AppointmentStatus;
  source: 'booking_page' | 'staff';
  startsAt: string;
  endsAt: string;
  timezone: string;
  appointmentType: { id: string; name: string } | null;
  calendar: { id: string; name: string };
  hosts: { calendarId: string; name: string; userId: string | null }[];
  contact: { id: string; name: string } | null;
  invitee: { name: string | null; email: string | null; phone: string | null };
  notes: string | null;
  locationKind: LocationKind;
  locationDetails: string | null;
  joinUrl: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}

export interface CalendarConnectionSummary {
  id: string;
  calendarId: string;
  provider: string;
  providerLabel: string;
  externalCalendarId: string;
  status: 'active' | 'configuration_required' | 'error' | 'disconnected';
  checkConflicts: boolean;
  writeEvents: boolean;
  configuredFields: string[];
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface CalendarProviderInfo {
  key: string;
  label: string;
  credentialFields: { key: string; label: string; secret: boolean }[];
}

export interface PublicBookingPage {
  page: { slug: string; title: string; description: string | null };
  organization: { name: string; timezone: string };
  appointmentTypes: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    durationMinutes: number;
    locationKind: LocationKind;
    schedulingMode: SchedulingMode;
  }[];
}

export interface ManagedAppointment {
  id: string;
  title: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationKind: LocationKind;
  locationDetails: string | null;
  joinUrl: string | null;
  inviteeName: string | null;
  organization: { name: string };
  appointmentTypeId: string | null;
  bookingPageSlug: string | null;
  canChange: boolean;
}
