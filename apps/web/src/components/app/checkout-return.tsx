'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest, ApiError } from '@/lib/api-client';

type State = 'verifying' | 'completed' | 'failed' | 'expired' | 'pending';

interface VerifyResponse {
  checkout: { id: string; status: 'open' | 'completed' | 'failed' | 'expired' };
}

/**
 * Asks the server to verify the payment with the provider. Anything the provider appended to
 * the return URL is ignored; only the server's verification counts.
 */
export function CheckoutReturn({
  organizationId,
  checkoutId,
}: {
  organizationId: string;
  checkoutId: string;
}) {
  const m = useMessages();
  const [state, setState] = useState<State>('verifying');
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      attempts.current += 1;
      try {
        const result = await apiRequest<VerifyResponse>(
          `/app/orgs/${organizationId}/billing/checkout/${checkoutId}/verify`,
          { method: 'POST', body: {} },
        );
        if (cancelled) return;
        const status = result.checkout.status;
        if (status === 'open') {
          setState(attempts.current > 3 ? 'pending' : 'verifying');
          if (attempts.current < 30) timer = setTimeout(() => void poll(), 2_000);
        } else {
          setState(status);
        }
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof ApiError ? caught.message : m.common.genericError);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [organizationId, checkoutId, m.common.genericError]);

  return (
    <div className="max-w-lg space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {state === 'verifying' || state === 'pending' ? (
        <p className="flex items-center gap-2 text-sm text-slate-700" role="status">
          <Spinner className="size-4" />
          {state === 'verifying' ? m.app.billing.verifying : m.app.billing.stillPending}
        </p>
      ) : null}
      {state === 'completed' ? <Alert tone="success">{m.app.billing.completed}</Alert> : null}
      {state === 'failed' ? <Alert tone="error">{m.app.billing.failed}</Alert> : null}
      {state === 'expired' ? <Alert tone="info">{m.app.billing.expired}</Alert> : null}
      <Link
        href={`/o/${organizationId}/billing`}
        className="text-sm font-medium text-brand-600 hover:underline"
      >
        {m.app.billing.backToBilling}
      </Link>
    </div>
  );
}
