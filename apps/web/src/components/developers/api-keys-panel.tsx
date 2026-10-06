'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import type { ApiKeySummary, DeveloperOverview } from '@/lib/developer-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { SecretReveal } from './secret-reveal';
import { StatusBadge } from './status-badge';

const EXPIRY_OPTIONS = [30, 90, 365] as const;

/** The organization's API keys: create (shown once), list, revoke. */
export function ApiKeysPanel({
  overview,
  keys,
  timezone,
}: {
  overview: DeveloperOverview;
  keys: ApiKeySummary[];
  timezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/developers/api-keys`;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const create = useMutation();
  const revoke = useMutation();

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const issued: { key: string | null } = { key: null };
    const ok = await create.run(async () => {
      const result = await apiRequest<{ key: string }>(base, {
        body: { name, scopes, expiresInDays: expiry ? Number(expiry) : null },
      });
      issued.key = result.key;
    });
    if (ok) {
      setOpen(false);
      setName('');
      setScopes([]);
      setExpiry('');
      setRevealed(issued.key);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{m.developers.keysTitle}</h2>
        {overview.enabled && overview.scopes.length > 0 ? (
          <Button
            size="sm"
            onClick={() => {
              create.reset();
              setOpen(true);
            }}
          >
            {m.developers.newKey}
          </Button>
        ) : null}
      </div>
      {revoke.error ? <Alert tone="error">{revoke.error.message}</Alert> : null}
      {keys.length === 0 ? (
        <p className="text-sm text-slate-500">{m.developers.keysEmpty}</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={m.developers.keysTitle}>
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                  <span className="break-all">{key.name}</span>
                  <StatusBadge
                    tone={key.status === 'active' ? 'good' : 'muted'}
                    label={m.developers.status[key.status]}
                  />
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  <code dir="ltr">{key.prefix}…</code> ·{' '}
                  <span title={key.scopes.join(', ')}>
                    {format(m.developers.scopeCount, { count: String(key.scopes.length) })}
                  </span>{' '}
                  · {m.developers.created} {formatDate(key.createdAt, timezone)} ·{' '}
                  {m.developers.lastUsed}{' '}
                  {key.lastUsedAt ? formatDateTime(key.lastUsedAt, timezone) : m.developers.never}
                </p>
              </div>
              {key.status === 'active' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={revoke.pending}
                  onClick={() => {
                    if (window.confirm(format(m.developers.revokeConfirm, { name: key.name }))) {
                      void revoke.run(() => apiRequest(`${base}/${key.id}/revoke`, { body: {} }));
                    }
                  }}
                >
                  {m.developers.revoke}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title={m.developers.newKey}>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          {create.error && create.error.code !== 'validation_error' ? (
            <Alert tone="error">{create.error.message}</Alert>
          ) : null}
          <TextField
            label={m.developers.keyName}
            hint={m.developers.keyNameHint}
            required
            maxLength={100}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={create.error?.fieldError('name')}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">{m.developers.scopes}</legend>
            <p className="text-xs text-slate-500">{m.developers.scopesHint}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {overview.scopes.map((entry) => (
                <CheckboxField
                  key={entry.scope}
                  label={entry.label}
                  checked={scopes.includes(entry.scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, entry.scope]
                        : current.filter((scope) => scope !== entry.scope),
                    )
                  }
                />
              ))}
            </div>
            {create.error?.fieldError('scopes') ? (
              <p className="text-sm text-red-600">{create.error.fieldError('scopes')}</p>
            ) : null}
          </fieldset>
          <SelectField
            label={m.developers.expiry}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          >
            <option value="">{m.developers.expiryNever}</option>
            {EXPIRY_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {format(m.developers.expiryDays, { days: String(days) })}
              </option>
            ))}
          </SelectField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button
              type="submit"
              loading={create.pending}
              disabled={!name.trim() || scopes.length === 0}
            >
              {m.developers.create}
            </Button>
          </div>
        </form>
      </Dialog>

      <SecretReveal
        title={m.developers.keyCreatedTitle}
        warning={m.developers.keyCreatedWarning}
        secret={revealed}
        onClose={() => setRevealed(null)}
      />
    </Card>
  );
}
