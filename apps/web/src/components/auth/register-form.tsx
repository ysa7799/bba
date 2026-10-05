'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest, ApiError } from '@/lib/api-client';

export function RegisterForm() {
  const m = useMessages();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest('/app/auth/register', { body: form });
      router.push(`/check-email?email=${encodeURIComponent(form.email)}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
      setPending(false);
    }
  }

  const update = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      <TextField
        label={m.auth.name}
        name="name"
        autoComplete="name"
        required
        value={form.name}
        onChange={update('name')}
        error={error?.fieldError('name')}
      />
      <TextField
        label={m.auth.email}
        type="email"
        name="email"
        autoComplete="email"
        required
        value={form.email}
        onChange={update('email')}
        error={error?.fieldError('email')}
      />
      <TextField
        label={m.auth.password}
        type="password"
        name="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={form.password}
        onChange={update('password')}
        hint={m.auth.register.passwordHint}
        error={error?.fieldError('password')}
      />
      <Button type="submit" loading={pending} className="w-full">
        {m.auth.register.submit}
      </Button>
    </form>
  );
}
