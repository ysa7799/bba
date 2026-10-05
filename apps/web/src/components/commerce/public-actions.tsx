'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { format } from '@/i18n';
import { apiRequest, ApiError } from '@/lib/api-client';

/** Starts the online payment and sends the customer to the provider's payment page. */
export function PayButton({ token, label }: { token: string; label: string }) {
  const m = useMessages();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setPending(true);
    setError(null);
    try {
      const { redirectUrl } = await apiRequest<{ redirectUrl: string }>(
        `/public/commerce/invoices/${token}/checkout`,
        { body: {} },
      );
      window.location.assign(redirectUrl);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
      setPending(false);
    }
  }

  return (
    <div className="space-y-2 print:hidden">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button className="w-full sm:w-auto" loading={pending} onClick={() => void pay()}>
        {pending ? m.commerce.public.paying : label}
      </Button>
    </div>
  );
}

/**
 * Back from the provider: asks the server to verify the payment with the provider (the
 * redirect itself proves nothing), then re-renders with the verified state.
 */
export function PaymentReturn({ token, open }: { token: string; open: boolean }) {
  const m = useMessages();
  const router = useRouter();
  const started = useRef(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    apiRequest(`/public/commerce/invoices/${token}/refresh`, { body: {} })
      .catch(() => null)
      .finally(() => {
        setChecked(true);
        router.refresh();
      });
  }, [token, router]);

  if (!checked) return <Alert tone="info">{m.commerce.public.checking}</Alert>;
  return open ? <Alert tone="info">{m.commerce.public.notPaidYet}</Alert> : null;
}

/** Accept or decline a quote from the customer's link. */
export function QuoteResponse({ token, organization }: { token: string; organization: string }) {
  const m = useMessages();
  const router = useRouter();
  const [pending, setPending] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(decision: 'accept' | 'decline') {
    setPending(decision);
    setError(null);
    try {
      await apiRequest(`/public/commerce/quotes/${token}/respond`, { body: { decision } });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2 print:hidden">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="text-sm text-slate-600">
        {format(m.commerce.public.acceptConfirm, { organization })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          loading={pending === 'accept'}
          disabled={pending !== null}
          onClick={() => void respond('accept')}
        >
          {m.commerce.public.accept}
        </Button>
        <Button
          variant="secondary"
          loading={pending === 'decline'}
          disabled={pending !== null}
          onClick={() => void respond('decline')}
        >
          {m.commerce.public.decline}
        </Button>
      </div>
    </div>
  );
}

/** Development stand-in for the provider's hosted payment page (invoice payments). */
export function FakeInvoiceCheckout({
  paymentId,
  returnPath,
}: {
  paymentId: string;
  returnPath: string;
}) {
  const m = useMessages();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete(status: 'captured' | 'failed') {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/public/commerce/dev/fake-payments/${paymentId}/complete`, {
        body: { status },
      });
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
        {m.commerce.devCheckout.pay}
      </Button>
      <Button
        className="w-full"
        variant="secondary"
        disabled={pending}
        onClick={() => void complete('failed')}
      >
        {m.commerce.devCheckout.decline}
      </Button>
    </div>
  );
}
