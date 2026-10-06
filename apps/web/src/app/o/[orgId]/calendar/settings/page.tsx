import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { AvailabilityEditor } from '@/components/calendar/availability-editor';
import { BookingPagesPanel } from '@/components/calendar/booking-pages-panel';
import { CalendarsPanel } from '@/components/calendar/calendars-panel';
import { ConnectionsPanel } from '@/components/calendar/connections-panel';
import { SetUpMyCalendar } from '@/components/calendar/set-up-my-calendar';
import { AppointmentTypesPanel } from '@/components/calendar/types-panel';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type {
  AppointmentTypeSummary,
  Availability,
  BookingPageSummary,
  CalendarConnectionSummary,
  CalendarProviderInfo,
  CalendarSummary,
} from '@/lib/calendar-types';
import { requestTime } from '@/lib/clock';
import type { OAuthProviderInfo } from '@/lib/integration-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';
import { zonedDate } from '@/lib/zoned-time';

export default async function SchedulingSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('calendar.appointment.read')) {
    return <CrmForbidden title={m.calendar.settingsTitle} message={m.calendar.settingsForbidden} />;
  }
  const base = `/app/orgs/${orgId}/calendar`;
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';
  const [calendars, types, pages] = await Promise.all([
    serverGetJson<{ data: CalendarSummary[] }>(`${base}/calendars`),
    serverGetJson<{ data: AppointmentTypeSummary[] }>(`${base}/appointment-types`),
    serverGetJson<{ data: BookingPageSummary[] }>(`${base}/booking-pages`),
  ]);
  if (!calendars || !types || !pages) notFound();
  const mine = calendars.data.find((calendar) => calendar.user?.id === me.user.id) ?? null;
  const requested = typeof query.calendar === 'string' ? query.calendar : null;
  const selected = calendars.data.find((calendar) => calendar.id === requested) ?? mine ?? null;
  const canEditSelected =
    selected !== null &&
    (can('calendar.manage') ||
      (selected.user?.id === me.user.id && can('calendar.appointment.manage')));
  const today = zonedDate(requestTime(), selected?.timezone ?? timezone);
  const [availability, connections, providers, oauthProviders] = await Promise.all([
    selected
      ? serverGetJson<{ availability: Availability }>(
          `${base}/calendars/${selected.id}/availability`,
        )
      : Promise.resolve(null),
    selected && canEditSelected
      ? serverGetJson<{ data: CalendarConnectionSummary[] }>(
          `${base}/calendars/${selected.id}/connections`,
        )
      : Promise.resolve(null),
    canEditSelected
      ? serverGetJson<{ encryptionConfigured: boolean; data: CalendarProviderInfo[] }>(
          `${base}/calendar-providers`,
        )
      : Promise.resolve(null),
    canEditSelected
      ? serverGetJson<{ data: OAuthProviderInfo[] }>(`/app/orgs/${orgId}/integrations/providers`)
      : Promise.resolve(null),
  ]);

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.calendar.settingsTitle} />
      <div className="space-y-6">
        {!mine && can('calendar.appointment.manage') ? <SetUpMyCalendar /> : null}
        {selected && availability ? (
          <Section
            title={`${selected.id === mine?.id ? m.calendar.myAvailability : m.calendar.availabilityFor} · ${selected.name}`}
          >
            <AvailabilityEditor
              key={selected.id}
              calendar={selected}
              availability={{
                ...availability.availability,
                exceptions: availability.availability.exceptions.filter(
                  (exception) => exception.date >= today,
                ),
              }}
              editable={canEditSelected}
            />
          </Section>
        ) : null}
        {selected && connections && providers ? (
          <Section title={m.calendar.connections}>
            <ConnectionsPanel
              calendarId={selected.id}
              connections={connections.data}
              providers={providers.data}
              encryptionConfigured={providers.encryptionConfigured}
              oauthProviders={oauthProviders?.data ?? []}
            />
          </Section>
        ) : null}
        <Section title={m.calendar.calendars}>
          <CalendarsPanel
            calendars={calendars.data}
            selectedId={selected?.id ?? null}
            defaultTimezone={timezone}
          />
        </Section>
        <Section title={m.calendar.types}>
          <AppointmentTypesPanel
            types={types.data}
            calendars={calendars.data.filter((calendar) => calendar.isActive)}
          />
        </Section>
        <Section title={m.calendar.pages}>
          <BookingPagesPanel pages={pages.data} types={types.data} />
        </Section>
      </div>
    </OrgAccessBoundary>
  );
}
