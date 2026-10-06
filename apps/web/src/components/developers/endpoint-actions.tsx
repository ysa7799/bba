'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';
import type { WebhookEndpointSummary } from '@/lib/developer-types';
import { EndpointForm } from './endpoint-form';
import { SecretReveal } from './secret-reveal';

/** Fired after a test event is queued so the delivery log refreshes itself. */
export const DELIVERIES_CHANGED = 'businessos:webhook-deliveries-changed';

export function EndpointActions({
  endpoint,
  eventTypes,
  enabled,
}: {
  endpoint: WebhookEndpointSummary;
  eventTypes: string[];
  /** The plan includes the API (test events need it). */
  enabled: boolean;
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/developers/webhooks/${endpoint.id}`;
  const { run, pending, error } = useMutation();
  const edit = useMutation();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  async function sendTest() {
    setNotice(null);
    const ok = await run(() => apiRequest(`${base}/test`, { body: {} }), { refresh: false });
    if (ok) {
      setNotice(m.developers.testQueued);
      window.dispatchEvent(new Event(DELIVERIES_CHANGED));
    }
  }

  async function rotate() {
    if (!window.confirm(m.developers.rotateConfirm)) return;
    const issued: { secret: string | null } = { secret: null };
    const ok = await run(async () => {
      const result = await apiRequest<{ secret: string }>(`${base}/rotate-secret`, { body: {} });
      issued.secret = result.secret;
    });
    if (ok) setRevealed(issued.secret);
  }

  async function remove() {
    if (!window.confirm(m.developers.deleteConfirm)) return;
    const ok = await run(() => apiRequest(base, { method: 'DELETE' }), { refresh: false });
    if (ok) router.push(`/o/${organizationId}/developers`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {endpoint.status === 'active' && enabled ? (
          <Button size="sm" loading={pending} onClick={() => void sendTest()}>
            {m.developers.sendTest}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            void run(() =>
              apiRequest(base, {
                method: 'PATCH',
                body: { enabled: endpoint.status !== 'active' },
              }),
            )
          }
        >
          {endpoint.status === 'active' ? m.developers.turnOff : m.developers.turnOn}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            edit.reset();
            setEditing(true);
          }}
        >
          {m.developers.editEndpoint}
        </Button>
        <Button size="sm" variant="secondary" loading={pending} onClick={() => void rotate()}>
          {m.developers.rotate}
        </Button>
        <Button size="sm" variant="danger" loading={pending} onClick={() => void remove()}>
          {m.developers.delete}
        </Button>
      </div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Dialog open={editing} onClose={() => setEditing(false)} title={m.developers.editEndpoint}>
        <EndpointForm
          eventTypes={eventTypes}
          initial={{
            url: endpoint.url,
            description: endpoint.description ?? '',
            events: endpoint.events,
          }}
          pending={edit.pending}
          error={edit.error}
          submitLabel={m.developers.save}
          onSubmit={(values) =>
            void edit
              .run(() =>
                apiRequest(base, {
                  method: 'PATCH',
                  body: {
                    url: values.url,
                    description: values.description || null,
                    events: values.events,
                  },
                }),
              )
              .then((ok) => {
                if (ok) setEditing(false);
              })
          }
          onCancel={() => setEditing(false)}
        />
      </Dialog>

      <SecretReveal
        title={m.developers.secretCreatedTitle}
        warning={m.developers.secretCreatedWarning}
        secret={revealed}
        onClose={() => setRevealed(null)}
      />
    </div>
  );
}
