'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest, ApiError } from '@/lib/api-client';

export function ResetPasswordForm({ token }: { token: string }) {
  const m = useMessages();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest('/app/auth/reset-password', { body: { token, password } });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success">{m.auth.reset.success}</Alert>
        <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">
          {m.auth.verify.continue}
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      <TextField
        label={m.auth.reset.newPassword}
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={m.auth.register.passwordHint}
        error={error?.fieldError('password')}
      />
      <Button type="submit" loading={pending} className="w-full">
        {m.auth.reset.submit}
      </Button>
    </form>
  );
}
