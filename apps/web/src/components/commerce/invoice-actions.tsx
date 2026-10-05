'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import { MANUAL_PAYMENT_METHODS, type InvoiceDetail } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';

/** Shows a just-created customer link with a copy button. */
export function SharedLink({ link, emailed }: { link: string; emailed: boolean | null }) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-medium text-slate-900">{m.commerce.customerLink}</p>
      <p className="break-all font-mono text-xs text-slate-700" data-testid="customer-link">
        {link}
      </p>
      <p className="text-xs text-slate-500">{m.commerce.customerLinkHint}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard
              .writeText(link)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {m.commerce.copyLink}
        </Button>
        {copied ? <span className="text-xs text-emerald-700">{m.commerce.linkCopied}</span> : null}
        {emailed === true ? (
          <span className="text-xs text-emerald-700">{m.commerce.emailed}</span>
        ) : emailed === false ? (
          <span className="text-xs text-slate-600">{m.commerce.notEmailed}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Issue / share / void / delete / record payment controls for one invoice. */
export function InvoiceActions({ invoice }: { invoice: InvoiceDetail }) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const canCreate = useCan('commerce.invoice.create');
  const canUpdate = useCan('commerce.invoice.update');
  const { run, pending, error, reset } = useMutation();
  const [dialog, setDialog] = useState<'issue' | 'resend' | 'void' | 'delete' | 'pay' | null>(null);
  const [email, setEmail] = useState(true);
  const [shared, setShared] = useState<{ link: string; emailed: boolean | null } | null>(null);
  const [amount, setAmount] = useState(invoice.amountDue.amount);
  const [method, setMethod] = useState<(typeof MANUAL_PAYMENT_METHODS)[number]>('bank_transfer');
  const [reference, setReference] = useState('');
  const path = `/app/orgs/${organizationId}/commerce/invoices/${invoice.id}`;
  const base = `/o/${organizationId}/commerce/invoices`;
  const hasPendingAttempt = invoice.attempts.some((attempt) =>
    ['pending', 'requires_action', 'authorized'].includes(attempt.status),
  );

  function close() {
    setDialog(null);
    reset();
  }

  async function share(action: 'issue' | 'resend') {
    let result: { link: string; emailed: boolean } | null = null;
    const ok = await run(async () => {
      result = await apiRequest<{ link: string; emailed: boolean }>(`${path}/${action}`, {
        body: { email },
      });
    });
    const sent = result as { link: string; emailed: boolean } | null;
    if (ok && sent) {
      setShared({ link: sent.link, emailed: email ? sent.emailed : null });
      setDialog(null);
    }
  }

  async function recordPayment(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`${path}/payments`, {
        body: { amount, method, ...(reference.trim() ? { reference: reference.trim() } : {}) },
      }),
    );
    if (ok) {
      setDialog(null);
      setReference('');
    }
  }

  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap gap-2">
        {invoice.status === 'draft' && canCreate ? (
          <Link
            href={`${base}/${invoice.id}/edit`}
            className="inline-flex h-10 items-center rounded-md px-4 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.commerce.edit}
          </Link>
        ) : null}
        {invoice.status === 'draft' && canUpdate ? (
          <Button onClick={() => setDialog('issue')}>{m.commerce.issue}</Button>
        ) : null}
        {invoice.status === 'open' && canUpdate ? (
          <Button
            onClick={() => {
              setAmount(invoice.amountDue.amount);
              setDialog('pay');
            }}
          >
            {m.commerce.recordPayment}
          </Button>
        ) : null}
        {(invoice.status === 'open' || invoice.status === 'paid') && canUpdate ? (
          <Button variant="secondary" onClick={() => setDialog('resend')}>
            {m.commerce.resend}
          </Button>
        ) : null}
        {invoice.status !== 'draft' ? (
          <Link
            href={`${base}/${invoice.id}/print`}
            className="inline-flex h-10 items-center rounded-md px-4 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            {m.commerce.print}
          </Link>
        ) : null}
        {hasPendingAttempt ? (
          <Button
            variant="secondary"
            loading={pending && dialog === null}
            onClick={() => void run(() => apiRequest(`${path}/refresh-payments`, { body: {} }))}
          >
            {m.commerce.checkPayments}
          </Button>
        ) : null}
        {invoice.status === 'open' && invoice.amountPaid.amountMinor === '0' && canUpdate ? (
          <Button variant="ghost" onClick={() => setDialog('void')}>
            {m.commerce.void}
          </Button>
        ) : null}
        {invoice.status === 'draft' && canCreate ? (
          <Button variant="ghost" onClick={() => setDialog('delete')}>
            {m.commerce.deleteDraft}
          </Button>
        ) : null}
      </div>
      {error && dialog === null ? <Alert tone="error">{error.message}</Alert> : null}
      {shared ? <SharedLink link={shared.link} emailed={shared.emailed} /> : null}

      <Dialog
        open={dialog === 'issue' || dialog === 'resend'}
        onClose={close}
        title={dialog === 'issue' ? m.commerce.issueTitle : m.commerce.resend}
      >
        <p className="text-sm text-slate-700">
          {dialog === 'issue' ? m.commerce.issueBody : m.commerce.resendBody}
        </p>
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
          <Button
            loading={pending}
            onClick={() => void share(dialog === 'issue' ? 'issue' : 'resend')}
          >
            {dialog === 'issue' ? m.commerce.issue : m.commerce.resend}
          </Button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'pay'} onClose={close} title={m.commerce.recordPaymentTitle}>
        <form onSubmit={recordPayment} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={`${m.commerce.amount} (${invoice.currency})`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            hint={`${m.commerce.amountDue}: ${formatMoney(invoice.amountDue)}`}
            error={error?.fieldError('amount')}
            required
          />
          <SelectField
            label={m.commerce.method}
            value={method}
            onChange={(event) =>
              setMethod(event.target.value as (typeof MANUAL_PAYMENT_METHODS)[number])
            }
          >
            {MANUAL_PAYMENT_METHODS.map((entry) => (
              <option key={entry} value={entry}>
                {m.commerce.methods[entry]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={m.commerce.reference}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={200}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={close}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.commerce.recordPayment}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={dialog === 'void'}
        title={m.commerce.void}
        message={m.commerce.voidConfirm}
        confirmLabel={m.commerce.void}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={close}
        onConfirm={() =>
          void run(async () => {
            await apiRequest(`${path}/void`, { body: {} });
            setDialog(null);
          })
        }
      />
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
              router.push(base);
            },
            { refresh: false },
          )
        }
      />
    </div>
  );
}

/** Refund one applied payment (owner/admin). The API bounds the amount. */
export function RefundButton({
  invoiceId,
  payment,
}: {
  invoiceId: string;
  payment: InvoiceDetail['payments'][number];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canRefund = useCan('commerce.payment.refund');
  const { run, pending, error, reset } = useMutation();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  if (!canRefund || payment.refundable.amountMinor === '0') return null;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(
        `/app/orgs/${organizationId}/commerce/invoices/${invoiceId}/payments/${payment.id}/refund`,
        { body: { amount, reason } },
      ),
    );
    if (ok) setOpen(false);
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {m.commerce.refund}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={m.commerce.refundTitle}
      >
        <form onSubmit={submit} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={`${m.commerce.amount} (${payment.amount.currency})`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            hint={format(m.commerce.refundHint, { amount: formatMoney(payment.refundable) })}
            error={error?.fieldError('amount')}
            required
          />
          <TextField
            label={m.commerce.refundReason}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" variant="danger" loading={pending}>
              {m.commerce.refund}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
