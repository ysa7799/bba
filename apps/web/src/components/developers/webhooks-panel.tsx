'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import type { DeveloperOverview, WebhookEndpointSummary } from '@/lib/developer-types';
import { EndpointBadge } from './status-badge';
import { EndpointForm } from './endpoint-form';
import { SecretReveal } from './secret-reveal';

/** The organization's webhook endpoints: add (secret shown once) and list. */
export function WebhooksPanel({
  overview,
  endpoints,
}: {
  overview: DeveloperOverview;
  endpoints: WebhookEndpointSummary[];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const create = useMutation();

  async function add(values: { url: string; description: string; events: string[] }) {
    const issued: { secret: string | null } = { secret: null };
    const ok = await create.run(async () => {
      const result = await apiRequest<{ secret: string }>(
        `/app/orgs/${organizationId}/developers/webhooks`,
        {
          body: {
            url: values.url,
            description: values.description || null,
            events: values.events,
          },
        },
      );
      issued.secret = result.secret;
    });
    if (ok) {
      setOpen(false);
      setRevealed(issued.secret);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{m.developers.webhooksTitle}</h2>
        {overview.enabled ? (
          <Button
            size="sm"
            onClick={() => {
              create.reset();
              setOpen(true);
            }}
          >
            {m.developers.newEndpoint}
          </Button>
        ) : null}
      </div>
      {endpoints.length === 0 ? (
        <p className="text-sm text-slate-500">{m.developers.webhooksEmpty}</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={m.developers.webhooksTitle}>
          {endpoints.map((endpoint) => (
            <li key={endpoint.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <code dir="ltr" className="break-all text-sm font-medium text-slate-900">
                    {endpoint.url}
                  </code>
                  <EndpointBadge endpoint={endpoint} labels={m.developers.status} />
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {endpoint.description ? `${endpoint.description} · ` : ''}
                  {format(m.developers.eventCount, { count: String(endpoint.events.length) })}
                  {endpoint.consecutiveFailures > 0
                    ? ` · ${format(m.developers.failures, {
                        count: String(endpoint.consecutiveFailures),
                      })}`
                    : ''}
                </p>
              </div>
              <Link
                href={`/o/${organizationId}/developers/webhooks/${endpoint.id}`}
                className="text-sm font-medium text-brand-700 hover:underline"
              >
                {m.developers.open}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title={m.developers.newEndpoint}>
        <EndpointForm
          eventTypes={overview.eventTypes}
          initial={{ url: '', description: '', events: [] }}
          pending={create.pending}
          error={create.error}
          submitLabel={m.developers.save}
          onSubmit={(values) => void add(values)}
          onCancel={() => setOpen(false)}
        />
      </Dialog>

      <SecretReveal
        title={m.developers.secretCreatedTitle}
        warning={m.developers.secretCreatedWarning}
        secret={revealed}
        onClose={() => setRevealed(null)}
      />
    </Card>
  );
}
