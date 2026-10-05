'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest, ApiError } from '@/lib/api-client';

type State = { status: 'pending' } | { status: 'done' } | { status: 'error'; message: string };

export function VerifyEmail({ token }: { token: string }) {
  const m = useMessages();
  const [state, setState] = useState<State>({ status: 'pending' });
  const started = useRef(false);

  useEffect(() => {
    // Tokens are single use: guard against React strict-mode double effects.
    if (started.current) return;
    started.current = true;
    apiRequest('/app/auth/verify-email', { body: { token } })
      .then(() => setState({ status: 'done' }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof ApiError ? error.message : m.common.genericError,
        }),
      );
  }, [token, m.common.genericError]);

  if (state.status === 'pending') {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
        <Spinner className="size-4" /> {m.auth.verify.verifying}
      </p>
    );
  }
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  return (
    <div className="space-y-4">
      <Alert tone="success">{m.auth.verify.success}</Alert>
      <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">
        {m.auth.verify.continue}
      </Link>
    </div>
  );
}
