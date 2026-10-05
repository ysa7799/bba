'use client';

import { useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api-client';
import { useOrg } from './org-access';

/** Starts a server-priced checkout and sends the browser to the provider's payment page. */
export function SubscribeButton({ priceId }: { priceId: string }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const { redirectUrl } = await apiRequest<{ redirectUrl: string }>(
        `/app/orgs/${organizationId}/billing/checkout`,
        { body: { priceId } },
      );
      window.location.assign(redirectUrl);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
      setPending(false);
    }
  }

  return (
    <div className="mt-4">
      <Button className="w-full" loading={pending} onClick={() => void start()}>
        {pending ? m.app.billing.redirecting : m.app.billing.subscribe}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
