'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type {
  CommerceSettings,
  CredentialField,
  PaymentConnection,
  TaxRate,
} from '@/lib/commerce-types';

export function TaxRatesPanel({ taxRates }: { taxRates: TaxRate[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('commerce.catalog.manage');
  const { run, pending, error } = useMutation();
  const [name, setName] = useState('VAT');
  const [percent, setPercent] = useState('10');
  const path = `/app/orgs/${organizationId}/commerce/tax-rates`;

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(() => apiRequest(path, { body: { name, percent } }));
  }

  return (
    <div className="space-y-4">
      {taxRates.length === 0 ? (
        <p className="text-sm text-slate-500">{m.commerce.emptyTaxRates}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm" data-testid="tax-rates">
          {taxRates.map((rate) => (
            <li key={rate.id} className="flex items-center justify-between gap-2 py-2">
              <span className={rate.archived ? 'text-slate-400' : 'text-slate-900'}>
                {rate.name} · {rate.percent}%{rate.archived ? ` (${m.commerce.archived})` : ''}
              </span>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      apiRequest(`${path}/${rate.id}`, {
                        method: 'PATCH',
                        body: { archived: !rate.archived },
                      }),
                    )
                  }
                >
                  {rate.archived ? m.commerce.restore : m.commerce.archive}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <TextField
            label={m.commerce.taxName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            error={error?.fieldError('name')}
          />
          <TextField
            label={m.commerce.taxPercent}
            inputMode="decimal"
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
            required
            className="w-32"
            error={error?.fieldError('percent')}
          />
          <Button type="submit" loading={pending}>
            {m.commerce.addTaxRate}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function NumberingForm({ settings }: { settings: CommerceSettings }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('commerce.settings.manage');
  const { run, pending, error } = useMutation();
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    invoicePrefix: settings.invoicePrefix,
    quotePrefix: settings.quotePrefix,
    nextInvoiceNumber: String(settings.nextInvoiceNumber),
    nextQuoteNumber: String(settings.nextQuoteNumber),
    defaultDueDays: String(settings.defaultDueDays),
    invoiceFooter: settings.invoiceFooter ?? '',
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/commerce/settings`, {
        method: 'PATCH',
        body: {
          invoicePrefix: form.invoicePrefix,
          quotePrefix: form.quotePrefix,
          nextInvoiceNumber: Number(form.nextInvoiceNumber),
          nextQuoteNumber: Number(form.nextQuoteNumber),
          defaultDueDays: Number(form.defaultDueDays),
          invoiceFooter: form.invoiceFooter.trim() || null,
        },
      }),
    );
    setSaved(ok);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {saved ? <Alert tone="success">{m.commerce.saved}</Alert> : null}
      <fieldset disabled={!canManage} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={m.commerce.invoicePrefix}
            value={form.invoicePrefix}
            onChange={set('invoicePrefix')}
            maxLength={20}
            error={error?.fieldError('invoicePrefix')}
          />
          <TextField
            label={m.commerce.nextInvoiceNumber}
            type="number"
            min={settings.nextInvoiceNumber}
            value={form.nextInvoiceNumber}
            onChange={set('nextInvoiceNumber')}
            hint={m.commerce.numbersForward}
            error={error?.fieldError('nextInvoiceNumber')}
          />
          <TextField
            label={m.commerce.quotePrefix}
            value={form.quotePrefix}
            onChange={set('quotePrefix')}
            maxLength={20}
            error={error?.fieldError('quotePrefix')}
          />
          <TextField
            label={m.commerce.nextQuoteNumber}
            type="number"
            min={settings.nextQuoteNumber}
            value={form.nextQuoteNumber}
            onChange={set('nextQuoteNumber')}
            error={error?.fieldError('nextQuoteNumber')}
          />
          <TextField
            label={m.commerce.defaultDueDays}
            type="number"
            min={0}
            max={365}
            value={form.defaultDueDays}
            onChange={set('defaultDueDays')}
            error={error?.fieldError('defaultDueDays')}
          />
        </div>
        <TextAreaField
          label={m.commerce.invoiceFooter}
          hint={m.commerce.invoiceFooterHint}
          value={form.invoiceFooter}
          onChange={set('invoiceFooter')}
          rows={3}
          maxLength={2000}
        />
        {canManage ? (
          <div className="flex justify-end">
            <Button type="submit" loading={pending}>
              {m.commerce.saveSettings}
            </Button>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}

export function PaymentConnectionPanel({
  connection,
  providers,
  credentialStorage,
}: {
  connection: PaymentConnection | null;
  providers: { name: string; label: string; credentialFields: CredentialField[] }[];
  credentialStorage: boolean;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [provider, setProvider] = useState(providers[0]?.name ?? '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const path = `/app/orgs/${organizationId}/commerce/payment-connection`;
  const fields =
    connection?.credentialFields ??
    providers.find((entry) => entry.name === provider)?.credentialFields ??
    [];
  const entered = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value.trim() !== ''),
  );

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = providers.find((entry) => entry.name === provider)?.label ?? provider;
    const ok = await run(() =>
      connection
        ? apiRequest(`${path}/${connection.id}`, {
            method: 'PATCH',
            body: { credentials: entered },
          })
        : apiRequest(path, { body: { provider, name: label, credentials: entered } }),
    );
    if (ok) setCredentials({});
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{m.commerce.onlinePaymentsHint}</p>
      {error && !confirm ? <Alert tone="error">{error.message}</Alert> : null}
      {!credentialStorage && fields.length > 0 ? (
        <Alert tone="info">{m.commerce.credentialStorageMissing}</Alert>
      ) : null}
      {connection ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="payment-connection">
          <dt className="text-slate-500">{m.commerce.provider}</dt>
          <dd className="text-slate-900">{connection.providerLabel}</dd>
          <dt className="text-slate-500">{m.commerce.connectionStatusLabel}</dt>
          <dd className="font-medium text-slate-900">
            {m.commerce.connectionStatus[connection.status]}
          </dd>
          <dt className="text-slate-500">{m.commerce.webhookUrl}</dt>
          <dd className="break-all font-mono text-xs text-slate-700">
            {connection.webhookUrl}
            <span className="mt-1 block font-sans text-slate-500">{m.commerce.webhookHint}</span>
          </dd>
        </dl>
      ) : null}
      {connection === null || fields.length > 0 ? (
        <form onSubmit={submit} className="space-y-3">
          {connection === null ? (
            <SelectField
              label={m.commerce.provider}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setCredentials({});
              }}
            >
              {providers.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.label}
                </option>
              ))}
            </SelectField>
          ) : null}
          {fields.map((field) => (
            <TextField
              key={field.key}
              label={field.label}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={credentials[field.key] ?? ''}
              onChange={(event) =>
                setCredentials((current) => ({ ...current, [field.key]: event.target.value }))
              }
              placeholder={
                connection?.configuredFields.includes(field.key)
                  ? m.commerce.configured
                  : m.commerce.notConfigured
              }
              hint={field.secret ? m.commerce.secretHint : undefined}
              error={error?.fieldError(`credentials.${field.key}`)}
            />
          ))}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="submit" loading={pending} disabled={!provider}>
              {connection ? m.commerce.updateCredentials : m.commerce.connect}
            </Button>
          </div>
        </form>
      ) : null}
      {connection ? (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            {m.commerce.disconnect}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={m.commerce.disconnect}
        message={m.commerce.disconnectConfirm}
        confirmLabel={m.commerce.disconnect}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={() => {
          setConfirm(false);
          reset();
        }}
        onConfirm={() =>
          void run(async () => {
            if (connection) await apiRequest(`${path}/${connection.id}`, { method: 'DELETE' });
            setConfirm(false);
          })
        }
      />
    </div>
  );
}
