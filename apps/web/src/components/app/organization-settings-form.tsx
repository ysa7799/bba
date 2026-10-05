'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { OrganizationSettings, OrganizationSummary } from '@/lib/api-types';
import { useCan, useOrg } from './org-access';
import { useMutation } from './use-mutation';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const CURRENCIES = ['BHD', 'SAR', 'AED', 'KWD', 'QAR', 'OMR', 'EGP', 'JOD', 'USD', 'EUR', 'GBP'];

export function OrganizationSettingsForm({
  organization,
  settings,
}: {
  organization: OrganizationSummary;
  settings: OrganizationSettings;
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const canEdit = useCan('organization.update');
  const [profile, setProfile] = useState({
    name: organization.name,
    countryCode: organization.countryCode,
    defaultCurrency: organization.defaultCurrency,
    timezone: organization.timezone,
    locale: organization.locale,
  });
  const [prefs, setPrefs] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { run, pending, error } = useMutation();
  const leave = useMutation();

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const ok = await run(async () => {
      await apiRequest(`/app/orgs/${organizationId}`, { method: 'PATCH', body: profile });
      await apiRequest(`/app/orgs/${organizationId}/settings`, { method: 'PATCH', body: prefs });
    });
    setSaved(ok);
  }

  return (
    <div className="max-w-2xl space-y-6">
      {!canEdit ? <Alert tone="info">{m.app.settings.readOnly}</Alert> : null}
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        {error && error.code !== 'validation_error' ? (
          <Alert tone="error">{error.message}</Alert>
        ) : null}
        {saved ? <Alert tone="success">{m.app.settings.saved}</Alert> : null}
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{m.app.settings.profile}</h2>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <TextField
              className="sm:col-span-2"
              label={m.app.settings.name}
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              error={error?.fieldError('name')}
            />
            <TextField
              label={m.onboarding.country}
              value={profile.countryCode}
              maxLength={2}
              onChange={(event) =>
                setProfile({ ...profile, countryCode: event.target.value.toUpperCase() })
              }
              error={error?.fieldError('countryCode')}
            />
            <SelectField
              label={m.onboarding.currency}
              value={profile.defaultCurrency}
              onChange={(event) => setProfile({ ...profile, defaultCurrency: event.target.value })}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </SelectField>
            <TextField
              label={m.onboarding.timezone}
              value={profile.timezone}
              onChange={(event) => setProfile({ ...profile, timezone: event.target.value })}
              error={error?.fieldError('timezone')}
            />
            <SelectField
              label={m.app.settings.locale}
              value={profile.locale}
              onChange={(event) => setProfile({ ...profile, locale: event.target.value })}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </SelectField>
          </fieldset>
        </Card>
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">{m.app.settings.preferences}</h2>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={m.app.settings.weekStart}
              value={prefs['general.week_start_day']}
              onChange={(event) =>
                setPrefs({ ...prefs, 'general.week_start_day': Number(event.target.value) })
              }
            >
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={m.app.settings.fiscalStart}
              value={prefs['general.fiscal_year_start_month']}
              onChange={(event) =>
                setPrefs({
                  ...prefs,
                  'general.fiscal_year_start_month': Number(event.target.value),
                })
              }
            >
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={m.app.settings.dateFormat}
              value={prefs['general.date_format']}
              onChange={(event) =>
                setPrefs({ ...prefs, 'general.date_format': event.target.value })
              }
            >
              {['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((formatOption) => (
                <option key={formatOption}>{formatOption}</option>
              ))}
            </SelectField>
          </fieldset>
        </Card>
        {canEdit ? (
          <Button type="submit" loading={pending}>
            {m.app.settings.save}
          </Button>
        ) : null}
      </form>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <span className="text-sm text-slate-700">{m.app.settings.leave}</span>
        <Button variant="danger" onClick={() => setLeaving(true)}>
          {m.app.settings.dangerZone}
        </Button>
      </Card>
      <ConfirmDialog
        open={leaving}
        title={m.app.settings.leave}
        message={m.app.settings.leaveConfirm}
        confirmLabel={m.app.settings.dangerZone}
        cancelLabel={m.common.cancel}
        pending={leave.pending}
        error={leave.error?.message ?? null}
        onClose={() => setLeaving(false)}
        onConfirm={async () => {
          const ok = await leave.run(() =>
            apiRequest(`/app/orgs/${organizationId}/leave`, { method: 'POST', body: {} }),
          );
          if (ok) router.replace('/');
        }}
      />
    </div>
  );
}
