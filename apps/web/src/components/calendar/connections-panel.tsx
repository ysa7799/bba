'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { CalendarConnectionSummary, CalendarProviderInfo } from '@/lib/calendar-types';

/** External calendars whose busy times block bookings (credentials are write-only). */
export function ConnectionsPanel({
  calendarId,
  connections,
  providers,
  encryptionConfigured,
}: {
  calendarId: string;
  connections: CalendarConnectionSummary[];
  providers: CalendarProviderInfo[];
  encryptionConfigured: boolean;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [open, setOpen] = useState(false);
  const [providerKey, setProviderKey] = useState(providers[0]?.key ?? '');
  const [externalCalendarId, setExternalCalendarId] = useState('primary');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const provider = providers.find((entry) => entry.key === providerKey) ?? null;
  const base = `/app/orgs/${organizationId}/calendar`;

  async function connect(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const filled = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => value.trim() !== ''),
    );
    const ok = await run(() =>
      apiRequest(`${base}/calendars/${calendarId}/connections`, {
        body: { provider: providerKey, externalCalendarId, credentials: filled },
      }),
    );
    if (ok) {
      setCredentials({});
      setOpen(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{m.calendar.connectionsHint}</p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {m.calendar.connect}
        </Button>
      </div>
      {error && !open ? <Alert tone="error">{error.message}</Alert> : null}
      {connections.length === 0 ? (
        <p className="text-sm text-slate-500">{m.calendar.noConnections}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {connection.providerLabel} · {connection.externalCalendarId}
                </p>
                <p className="text-xs text-slate-500">
                  {m.calendar.connectionStatus[connection.status]}
                  {connection.lastError ? ` · ${connection.lastError}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                loading={pending}
                onClick={() =>
                  void run(() =>
                    apiRequest(`${base}/calendar-connections/${connection.id}`, {
                      method: 'DELETE',
                    }),
                  )
                }
              >
                {m.calendar.disconnect}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={open}
        onClose={() => {
          reset();
          setOpen(false);
        }}
        title={m.calendar.connect}
      >
        <form onSubmit={connect} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <SelectField
            label={m.calendar.provider}
            value={providerKey}
            onChange={(event) => {
              setProviderKey(event.target.value);
              setCredentials({});
            }}
          >
            {providers.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </SelectField>
          <TextField
            label={m.calendar.externalCalendarId}
            required
            maxLength={320}
            value={externalCalendarId}
            onChange={(event) => setExternalCalendarId(event.target.value)}
          />
          {provider && provider.credentialFields.length > 0 && encryptionConfigured ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-slate-800">
                {m.calendar.credentials}
              </legend>
              <p className="text-xs text-slate-500">{m.calendar.credentialsHint}</p>
              {provider.credentialFields.map((field) => (
                <TextField
                  key={field.key}
                  label={field.label}
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  maxLength={4_000}
                  value={credentials[field.key] ?? ''}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                />
              ))}
            </fieldset>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.calendar.connect}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
