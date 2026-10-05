'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest, ApiError } from '@/lib/api-client';

export function LoginForm({ next }: { next: string | null }) {
  const m = useMessages();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResent(false);
    try {
      await apiRequest('/app/auth/login', { body: { email, password } });
      router.replace(next ?? '/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
      setPending(false);
    }
  }

  async function resend() {
    try {
      await apiRequest('/app/auth/resend-verification', { body: { email } });
    } finally {
      setResent(true);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error?.code === 'email_not_verified' ? (
        <Alert tone="info">
          <p>{m.auth.login.notVerified}</p>
          {resent ? (
            <p className="mt-2">{m.auth.login.resent}</p>
          ) : (
            <button type="button" onClick={resend} className="mt-2 font-medium underline">
              {m.auth.login.resend}
            </button>
          )}
        </Alert>
      ) : error ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      <TextField
        label={m.auth.email}
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={error?.fieldError('email')}
      />
      <TextField
        label={m.auth.password}
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-sm text-brand-600 hover:underline">
          {m.auth.login.forgot}
        </Link>
      </div>
      <Button type="submit" loading={pending} className="w-full">
        {m.auth.login.submit}
      </Button>
    </form>
  );
}
