'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { ChannelPublic } from '@/lib/inbox-types';

/** Opens (or reuses) a conversation with a contact on a chosen channel, then shows it. */
export function StartConversationButton({ contactId }: { contactId: string }) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const base = `/app/orgs/${organizationId}/communications`;

  async function openDialog() {
    setOpen(true);
    setLoadError(null);
    try {
      const result = await apiRequest<{ data: ChannelPublic[] }>(`${base}/channels`);
      const active = result.data.filter((channel) => channel.status === 'active');
      setChannels(active);
      setConnectionId(active[0]?.id ?? '');
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : m.common.genericError);
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const started: { id: string | null } = { id: null };
    const ok = await run(
      async () => {
        started.id = (
          await apiRequest<{ conversation: { id: string } }>(`${base}/conversations`, {
            body: { connectionId, contactId },
          })
        ).conversation.id;
      },
      { refresh: false },
    );
    if (ok && started.id) router.push(`/o/${organizationId}/inbox?c=${started.id}`);
  }

  return (
    <>
      <Button variant="secondary" onClick={() => void openDialog()}>
        {m.inbox.startConversation}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          reset();
          setOpen(false);
        }}
        title={m.inbox.startTitle}
      >
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600">{m.inbox.startHint}</p>
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          {channels === null ? (
            <p className="text-sm text-slate-500">{m.common.loading}</p>
          ) : channels.length === 0 ? (
            <p className="text-sm text-slate-500">{m.inbox.noChannels}</p>
          ) : (
            <SelectField
              label={m.inbox.channel}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name} · {m.inbox.channels[channel.channel]} · {channel.address}
                </option>
              ))}
            </SelectField>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending} disabled={!connectionId}>
              {m.inbox.start}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
