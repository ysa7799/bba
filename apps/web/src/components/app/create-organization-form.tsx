'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { OrganizationSummary } from '@/lib/api-types';

const COUNTRIES: [code: string, currency: string, timezone: string, label: string][] = [
  ['BH', 'BHD', 'Asia/Bahrain', 'Bahrain'],
  ['SA', 'SAR', 'Asia/Riyadh', 'Saudi Arabia'],
  ['AE', 'AED', 'Asia/Dubai', 'United Arab Emirates'],
  ['KW', 'KWD', 'Asia/Kuwait', 'Kuwait'],
  ['QA', 'QAR', 'Asia/Qatar', 'Qatar'],
  ['OM', 'OMR', 'Asia/Muscat', 'Oman'],
  ['EG', 'EGP', 'Africa/Cairo', 'Egypt'],
  ['JO', 'JOD', 'Asia/Amman', 'Jordan'],
  ['GB', 'GBP', 'Europe/London', 'United Kingdom'],
  ['US', 'USD', 'America/New_York', 'United States'],
];

const CURRENCIES = ['BHD', 'SAR', 'AED', 'KWD', 'QAR', 'OMR', 'EGP', 'JOD', 'USD', 'EUR', 'GBP'];

export function CreateOrganizationForm() {
  const m = useMessages();
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    countryCode: 'BH',
    defaultCurrency: 'BHD',
    timezone: 'Asia/Bahrain',
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  function onCountryChange(code: string) {
    const match = COUNTRIES.find(([country]) => country === code);
    setForm((current) => ({
      ...current,
      countryCode: code,
      ...(match ? { defaultCurrency: match[1], timezone: match[2] } : {}),
    }));
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { organization } = await apiRequest<{ organization: OrganizationSummary }>(
        '/app/orgs',
        { body: form },
      );
      router.replace(`/o/${organization.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      <TextField
        label={m.onboarding.name}
        required
        maxLength={200}
        value={form.name}
        onChange={(event) => setForm({ ...form, name: event.target.value })}
        error={error?.fieldError('name')}
      />
      <SelectField
        label={m.onboarding.country}
        value={form.countryCode}
        onChange={(event) => onCountryChange(event.target.value)}
        error={error?.fieldError('countryCode')}
      >
        {COUNTRIES.map(([code, , , label]) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={m.onboarding.currency}
        value={form.defaultCurrency}
        onChange={(event) => setForm({ ...form, defaultCurrency: event.target.value })}
        error={error?.fieldError('defaultCurrency')}
      >
        {CURRENCIES.map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </SelectField>
      <TextField
        label={m.onboarding.timezone}
        value={form.timezone}
        onChange={(event) => setForm({ ...form, timezone: event.target.value })}
        error={error?.fieldError('timezone')}
      />
      <Button type="submit" loading={pending} className="w-full">
        {m.onboarding.submit}
      </Button>
    </form>
  );
}
