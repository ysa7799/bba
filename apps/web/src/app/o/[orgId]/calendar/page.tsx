import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { AppointmentAgenda } from '@/components/calendar/appointment-agenda';
import { NewAppointmentButton } from '@/components/calendar/new-appointment';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { FilterSelect } from '@/components/crm/list-filters';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import type {
  AppointmentSummary,
  AppointmentTypeSummary,
  CalendarSummary,
} from '@/lib/calendar-types';
import { requestTime } from '@/lib/clock';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';
import { addDaysToDate, startOfWeek, startOfZonedDay, zonedDate } from '@/lib/zoned-time';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show', 'all'] as const;

export default async function CalendarPage({
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
    return <CrmForbidden title={m.calendar.title} message={m.calendar.forbidden} />;
  }
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';
  const requestedWeek =
    typeof query.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.week) ? query.week : null;
  const weekStart = startOfWeek(requestedWeek ?? zonedDate(requestTime(), timezone));
  const calendarId =
    typeof query.calendarId === 'string' && UUID.test(query.calendarId) ? query.calendarId : '';
  const status =
    typeof query.status === 'string' && (STATUSES as readonly string[]).includes(query.status)
      ? query.status
      : 'scheduled';
  const base = `/app/orgs/${orgId}/calendar`;
  const qs = new URLSearchParams({
    from: startOfZonedDay(weekStart, timezone),
    to: startOfZonedDay(addDaysToDate(weekStart, 7), timezone),
    status,
    limit: '200',
    ...(calendarId ? { calendarId } : {}),
  });
  const [appointments, calendars, types] = await Promise.all([
    serverGetJson<Page<AppointmentSummary>>(`${base}/appointments?${qs.toString()}`),
    serverGetJson<{ data: CalendarSummary[] }>(`${base}/calendars`),
    serverGetJson<{ data: AppointmentTypeSummary[] }>(`${base}/appointment-types`),
  ]);
  if (!appointments || !calendars || !types) notFound();
  const weekHref = (week: string) =>
    `?${new URLSearchParams({ week, status, ...(calendarId ? { calendarId } : {}) }).toString()}`;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.calendar.title}
        actions={
          can('calendar.appointment.manage') ? (
            <NewAppointmentButton
              calendars={calendars.data.filter((calendar) => calendar.isActive)}
              types={types.data.filter((type) => type.isActive)}
              timezone={timezone}
              canPickContact={can('crm.contact.read')}
            />
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <nav aria-label={m.calendar.title} className="flex items-center gap-2 text-sm">
          <Link
            href={weekHref(addDaysToDate(weekStart, -7))}
            className="rounded-md px-3 py-2 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            ← {m.calendar.previousWeek}
          </Link>
          <Link
            href={weekHref(startOfWeek(zonedDate(requestTime(), timezone)))}
            className="rounded-md px-3 py-2 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.calendar.thisWeek}
          </Link>
          <Link
            href={weekHref(addDaysToDate(weekStart, 7))}
            className="rounded-md px-3 py-2 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.calendar.nextWeek} →
          </Link>
        </nav>
        <form className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="week" value={weekStart} />
          <FilterSelect
            name="calendarId"
            label={m.calendar.calendarFilter}
            value={calendarId}
            options={[
              { value: '', label: m.calendar.allCalendars },
              ...calendars.data.map((calendar) => ({ value: calendar.id, label: calendar.name })),
            ]}
          />
          <FilterSelect
            name="status"
            label={m.calendar.statusFilter}
            value={status}
            options={STATUSES.map((value) => ({ value, label: m.calendar.statuses[value] }))}
          />
          <button
            type="submit"
            className="h-10 rounded-md bg-white px-4 text-sm font-medium text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.crm.filter}
          </button>
        </form>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        {format(m.calendar.timesIn, { zone: timezone })}
      </p>
      <AppointmentAgenda
        weekStart={weekStart}
        appointments={appointments.data}
        timezone={timezone}
      />
    </OrgAccessBoundary>
  );
}
