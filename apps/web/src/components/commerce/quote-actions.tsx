'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { CheckboxField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { QuoteDetail } from '@/lib/commerce-types';
import { SharedLink } from './invoice-actions';

export function QuoteActions({ quote }: { quote: QuoteDetail }) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const canCreate = useCan('commerce.invoice.create');
  const canUpdate = useCan('commerce.invoice.update');
  const { run, pending, error, reset } = useMutation();
  const [dialog, setDialog] = useState<'send' | 'delete' | null>(null);
  const [email, setEmail] = useState(true);
  const [shared, setShared] = useState<{ link: string; emailed: boolean | null } | null>(null);
  const path = `/app/orgs/${organizationId}/commerce/quotes/${quote.id}`;
  const base = `/o/${organizationId}/commerce`;

  function close() {
    setDialog(null);
    reset();
  }

  async function send() {
    let result: { link: string; emailed: boolean } | null = null;
    const ok = await run(async () => {
      result = await apiRequest<{ link: string; emailed: boolean }>(`${path}/send`, {
        body: { email },
      });
    });
    const sent = result as { link: string; emailed: boolean } | null;
    if (ok && sent) {
      setShared({ link: sent.link, emailed: email ? sent.emailed : null });
      setDialog(null);
    }
  }

  async function convert() {
    let invoiceId: string | null = null;
    const ok = await run(
      async () => {
        invoiceId = (await apiRequest<{ invoice: { id: string } }>(`${path}/convert`, { body: {} }))
          .invoice.id;
      },
      { refresh: false },
    );
    const id = invoiceId as string | null;
    if (ok && id) router.push(`${base}/invoices/${id}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {quote.status === 'draft' && canCreate ? (
          <Link
            href={`${base}/quotes/${quote.id}/edit`}
            className="inline-flex h-10 items-center rounded-md px-4 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.commerce.edit}
          </Link>
        ) : null}
        {(quote.status === 'draft' || quote.status === 'sent') && canUpdate ? (
          <Button
            variant={quote.status === 'draft' ? 'primary' : 'secondary'}
            onClick={() => setDialog('send')}
          >
            {quote.status === 'draft' ? m.commerce.send : m.commerce.resend}
          </Button>
        ) : null}
        {quote.status === 'sent' && canUpdate ? (
          <>
            <Button
              variant="secondary"
              loading={pending}
              onClick={() =>
                void run(() => apiRequest(`${path}/respond`, { body: { decision: 'accept' } }))
              }
            >
              {m.commerce.markAccepted}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void run(() => apiRequest(`${path}/respond`, { body: { decision: 'decline' } }))
              }
            >
              {m.commerce.markDeclined}
            </Button>
          </>
        ) : null}
        {(quote.status === 'accepted' || quote.status === 'sent') && canCreate ? (
          <Button
            variant={quote.status === 'accepted' ? 'primary' : 'secondary'}
            loading={pending}
            onClick={() => void convert()}
          >
            {m.commerce.convert}
          </Button>
        ) : null}
        {quote.convertedInvoiceId ? (
          <Link
            href={`${base}/invoices/${quote.convertedInvoiceId}`}
            className="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium text-brand-600 hover:underline"
          >
            {m.commerce.convertedTo}
          </Link>
        ) : null}
        {quote.status === 'draft' && canCreate ? (
          <Button variant="ghost" onClick={() => setDialog('delete')}>
            {m.commerce.deleteDraft}
          </Button>
        ) : null}
      </div>
      {error && dialog === null ? <Alert tone="error">{error.message}</Alert> : null}
      {shared ? <SharedLink link={shared.link} emailed={shared.emailed} /> : null}

      <Dialog open={dialog === 'send'} onClose={close} title={m.commerce.sendTitle}>
        <p className="text-sm text-slate-700">{m.commerce.sendBody}</p>
        <CheckboxField
          className="mt-4"
          label={m.commerce.emailCustomer}
          checked={email}
          onChange={(event) => setEmail(event.target.checked)}
        />
        {error ? (
          <div className="mt-3">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {m.common.cancel}
          </Button>
          <Button loading={pending} onClick={() => void send()}>
            {m.commerce.send}
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={dialog === 'delete'}
        title={m.commerce.deleteDraft}
        message={m.commerce.deleteDraftConfirm}
        confirmLabel={m.commerce.deleteDraft}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={close}
        onConfirm={() =>
          void run(
            async () => {
              await apiRequest(path, { method: 'DELETE' });
              router.push(`${base}/quotes`);
            },
            { refresh: false },
          )
        }
      />
    </div>
  );
}
