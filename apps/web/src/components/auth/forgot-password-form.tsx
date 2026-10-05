'use client';

import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest, ApiError } from '@/lib/api-client';

export function ForgotPasswordForm() {
  const m = useMessages();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest('/app/auth/forgot-password', { body: { email } });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setPending(false);
    }
  }

  if (sent) return <Alert tone="success">{m.auth.forgot.sent}</Alert>;
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <TextField
        label={m.auth.email}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={error?.fieldError('email')}
      />
      <Button type="submit" loading={pending} className="w-full">
        {m.auth.forgot.submit}
      </Button>
    </form>
  );
}
