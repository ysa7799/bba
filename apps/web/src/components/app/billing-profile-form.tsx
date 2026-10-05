'use client';

import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { BillingCustomer } from '@/lib/api-types';
import { useOrg } from './org-access';
import { useMutation } from './use-mutation';

export function BillingProfileForm({ customer }: { customer: BillingCustomer | null }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [form, setForm] = useState({
    legalName: customer?.legalName ?? '',
    billingEmail: customer?.billingEmail ?? '',
    taxId: customer?.taxId ?? '',
    countryCode: customer?.countryCode ?? 'BH',
    city: customer?.city ?? '',
  });
  const [saved, setSaved] = useState(false);
  const { run, pending, error } = useMutation();

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/billing/customer`, {
        method: 'PUT',
        body: { ...form, taxId: form.taxId || null, city: form.city || null },
      }),
    );
    setSaved(ok);
  }

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <Card className="p-5">
      <h2 className="mb-4 text-sm font-semibold">{m.app.billing.profile}</h2>
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error && error.code !== 'validation_error' ? (
          <div className="sm:col-span-2">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : null}
        {saved ? (
          <div className="sm:col-span-2">
            <Alert tone="success">{m.app.billing.saved}</Alert>
          </div>
        ) : null}
        <TextField
          label={m.app.billing.legalName}
          value={form.legalName}
          onChange={update('legalName')}
          error={error?.fieldError('legalName')}
        />
        <TextField
          label={m.app.billing.billingEmail}
          type="email"
          value={form.billingEmail}
          onChange={update('billingEmail')}
          error={error?.fieldError('billingEmail')}
        />
        <TextField
          label={m.app.billing.taxId}
          value={form.taxId}
          onChange={update('taxId')}
          error={error?.fieldError('taxId')}
        />
        <TextField
          label={m.onboarding.country}
          value={form.countryCode}
          maxLength={2}
          onChange={update('countryCode')}
          error={error?.fieldError('countryCode')}
        />
        <TextField label={m.app.billing.city} value={form.city} onChange={update('city')} />
        <div className="sm:col-span-2">
          <Button type="submit" loading={pending}>
            {m.app.billing.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
