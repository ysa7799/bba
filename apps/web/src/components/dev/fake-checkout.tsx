'use client';

import { useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api-client';

/** Development stand-in for a provider's hosted payment page. */
export function FakeCheckout({ paymentId, returnPath }: { paymentId: string; returnPath: string }) {
  const m = useMessages();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete(status: 'captured' | 'failed') {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/app/dev/payments/fake/${paymentId}/complete`, { body: { status } });
      window.location.assign(returnPath);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button className="w-full" loading={pending} onClick={() => void complete('captured')}>
        {m.app.devCheckout.pay}
      </Button>
      <Button
        className="w-full"
        variant="secondary"
        disabled={pending}
        onClick={() => void complete('failed')}
      >
        {m.app.devCheckout.decline}
      </Button>
    </div>
  );
}
