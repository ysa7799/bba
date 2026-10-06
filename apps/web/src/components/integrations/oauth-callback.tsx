'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, apiRequest } from '@/lib/api-client';

/** Completes a provider connection once, then returns the person to where they started. */
export function OAuthCallback({
  state,
  code,
  error,
}: {
  state: string;
  code: string | null;
  error: string | null;
}) {
  const m = useMessages();
  const router = useRouter();
  const started = useRef(false);
  const [failure, setFailure] = useState<{ message: string; signIn: boolean } | null>(null);

  useEffect(() => {
    // Development renders effects twice; the authorization can only be completed once.
    if (started.current) return;
    started.current = true;
    void apiRequest<{ redirectTo: string }>('/app/oauth/complete', {
      body: { state, ...(code ? { code } : {}), ...(error ? { error } : {}) },
    })
      .then((result) => {
        // Only ever an in-app path from the API.
        router.replace(result.redirectTo.startsWith('/o/') ? result.redirectTo : '/');
      })
      .catch((caught: unknown) => {
        const unauthenticated = caught instanceof ApiError && caught.status === 401;
        setFailure({
          message: unauthenticated
            ? m.integrations.callbackSignIn
            : caught instanceof ApiError
              ? caught.message
              : m.integrations.callbackFailed,
          signIn: unauthenticated,
        });
      });
  }, [state, code, error, router, m]);

  if (!failure) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
        <Spinner className="h-4 w-4" /> {m.integrations.callbackWorking}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <Alert tone="error">{failure.message}</Alert>
      <Link
        href={failure.signIn ? '/login' : '/'}
        className="text-sm font-medium text-brand-700 hover:underline"
      >
        {failure.signIn ? m.integrations.signIn : m.integrations.backToApp}
      </Link>
    </div>
  );
}
