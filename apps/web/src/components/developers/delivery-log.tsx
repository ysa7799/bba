'use client';

import { useEffect, useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { format } from '@/i18n';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { WebhookDeliverySummary } from '@/lib/developer-types';
import { formatDateTime } from '@/lib/format';
import { StatusBadge } from './status-badge';
import { DELIVERIES_CHANGED } from './endpoint-actions';

interface DeliveryPage {
  data: WebhookDeliverySummary[];
  nextCursor: string | null;
}

/** An endpoint's deliveries, newest first, with payloads on demand and manual resend. */
export function DeliveryLog({
  endpointId,
  initial,
  timezone,
  canResend,
}: {
  endpointId: string;
  initial: DeliveryPage;
  timezone: string;
  canResend: boolean;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/developers/webhooks/${endpointId}/deliveries`;
  const [items, setItems] = useState(initial.data);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [payloads, setPayloads] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function attempt(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setBusy(null);
    }
  }

  function reload() {
    void attempt('refresh', async () => {
      const page = await apiRequest<DeliveryPage>(`${base}?limit=20`);
      setItems(page.data);
      setCursor(page.nextCursor);
    });
  }

  useEffect(() => {
    // A test event was queued: show it once the worker has had a moment to send it.
    const onChanged = () => {
      window.setTimeout(() => {
        void apiRequest<DeliveryPage>(`${base}?limit=20`)
          .then((page) => {
            setItems(page.data);
            setCursor(page.nextCursor);
          })
          .catch(() => undefined);
      }, 1_500);
    };
    window.addEventListener(DELIVERIES_CHANGED, onChanged);
    return () => window.removeEventListener(DELIVERIES_CHANGED, onChanged);
  }, [base]);

  function more() {
    if (!cursor) return;
    void attempt('more', async () => {
      const page = await apiRequest<DeliveryPage>(
        `${base}?limit=20&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => [
        ...current,
        ...page.data.filter((entry) => !current.some((seen) => seen.id === entry.id)),
      ]);
      setCursor(page.nextCursor);
    });
  }

  function togglePayload(id: string) {
    if (payloads[id] !== undefined) {
      setPayloads((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
      );
      return;
    }
    void attempt(`payload-${id}`, async () => {
      const { delivery } = await apiRequest<{ delivery: { body: string } }>(`${base}/${id}`);
      let pretty = delivery.body;
      try {
        pretty = JSON.stringify(JSON.parse(delivery.body), null, 2);
      } catch {
        // Shown as stored.
      }
      setPayloads((current) => ({ ...current, [id]: pretty }));
    });
  }

  function resend(id: string) {
    void attempt(`resend-${id}`, async () => {
      await apiRequest(`${base}/${id}/redeliver`, { body: {} });
      window.dispatchEvent(new Event(DELIVERIES_CHANGED));
    });
  }

  const tone = (status: WebhookDeliverySummary['status']) =>
    status === 'succeeded' ? 'good' : status === 'failed' ? 'bad' : 'muted';

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{m.developers.deliveries}</h2>
        <Button size="sm" variant="ghost" loading={busy === 'refresh'} onClick={reload}>
          {m.developers.refresh}
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{m.developers.deliveriesEmpty}</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={m.developers.deliveries}>
          {items.map((delivery) => (
            <li key={delivery.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <code dir="ltr" className="font-medium text-slate-900">
                      {delivery.eventType}
                    </code>
                    <StatusBadge
                      tone={tone(delivery.status)}
                      label={m.developers.deliveryStatus[delivery.status]}
                    />
                    {delivery.responseStatus !== null ? (
                      <span className="text-xs text-slate-500">HTTP {delivery.responseStatus}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatDateTime(delivery.createdAt, timezone)} · {m.developers.attempts}{' '}
                    {delivery.attempts}
                    {delivery.durationMs !== null ? ` · ${delivery.durationMs} ms` : ''}
                    {delivery.nextAttemptAt
                      ? ` · ${format(m.developers.nextAttempt, {
                          time: formatDateTime(delivery.nextAttemptAt, timezone),
                        })}`
                      : ''}
                  </p>
                  {delivery.lastError && delivery.status !== 'succeeded' ? (
                    <p className="mt-0.5 break-words text-xs text-red-700">{delivery.lastError}</p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `payload-${delivery.id}`}
                    onClick={() => togglePayload(delivery.id)}
                  >
                    {payloads[delivery.id] !== undefined
                      ? m.developers.hidePayload
                      : m.developers.showPayload}
                  </Button>
                  {canResend && delivery.status !== 'pending' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `resend-${delivery.id}`}
                      onClick={() => resend(delivery.id)}
                    >
                      {m.developers.redeliver}
                    </Button>
                  ) : null}
                </div>
              </div>
              {payloads[delivery.id] !== undefined ? (
                <pre
                  dir="ltr"
                  className="mt-2 max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100"
                >
                  {payloads[delivery.id]}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="ghost" loading={busy === 'more'} onClick={more}>
            {m.developers.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
