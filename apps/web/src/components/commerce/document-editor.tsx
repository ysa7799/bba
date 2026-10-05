'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { inputClass, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { InvoiceDetail, Product, QuoteDetail, TaxRate } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';

export const CURRENCIES = ['BHD', 'SAR', 'AED', 'KWD', 'QAR', 'OMR', 'USD', 'EUR', 'GBP'];

interface LineState {
  key: number;
  productId: string;
  description: string;
  quantity: string;
  unitAmount: string;
  discountPercent: string;
  taxRateId: string;
}

let nextKey = 1;
function emptyLine(): LineState {
  return {
    key: nextKey++,
    productId: '',
    description: '',
    quantity: '1',
    unitAmount: '',
    discountPercent: '',
    taxRateId: '',
  };
}

/**
 * Draft editor for quotes and invoices. It sends what the user typed; prices, discounts, taxes
 * and totals are computed by the API (shown after saving), never in the browser.
 */
export function DocumentEditor({
  kind,
  document,
  products,
  taxRates,
  defaultCurrency,
  initialContact,
}: {
  kind: 'invoice' | 'quote';
  document?: InvoiceDetail | QuoteDetail;
  products: Product[];
  taxRates: TaxRate[];
  defaultCurrency: string;
  initialContact?: PickedRecord | null;
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [contact, setContact] = useState<PickedRecord | null>(
    document?.contact
      ? { id: document.contact.id, name: document.contact.name }
      : (initialContact ?? null),
  );
  const [deal, setDeal] = useState<PickedRecord | null>(null);
  const [currency, setCurrency] = useState(document?.currency ?? defaultCurrency);
  const [date, setDate] = useState(
    (document && 'dueDate' in document ? document.dueDate : null) ??
      (document && 'validUntil' in document ? document.validUntil : null) ??
      '',
  );
  const [notes, setNotes] = useState(document?.notes ?? '');
  const [terms, setTerms] = useState(document?.terms ?? '');
  const [lines, setLines] = useState<LineState[]>(
    document?.lines.map((line) => ({
      key: nextKey++,
      productId: line.productId ?? '',
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount.amount,
      discountPercent: line.discountPercent === '0' ? '' : line.discountPercent,
      taxRateId: line.tax?.id ?? '',
    })) ?? [emptyLine()],
  );
  const liveProducts = products.filter((product) => !product.archived);
  const liveTaxes = taxRates.filter((rate) => !rate.archived);
  const currencies = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];
  const plural = kind === 'invoice' ? 'invoices' : 'quotes';

  function update(key: number, patch: Partial<LineState>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function pickProduct(key: number, productId: string) {
    const product = liveProducts.find((entry) => entry.id === productId);
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? {
              ...line,
              productId,
              description: product && line.description === '' ? product.name : line.description,
              taxRateId: product?.taxRate?.id ?? line.taxRateId,
              unitAmount: '',
            }
          : line,
      ),
    );
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contact) return;
    const body = {
      contactId: contact.id,
      ...(deal ? { dealId: deal.id } : {}),
      currency,
      [kind === 'invoice' ? 'dueDate' : 'validUntil']: date || null,
      notes: notes.trim() || null,
      terms: terms.trim() || null,
      lines: lines.map((line) => ({
        productId: line.productId || null,
        description: line.description,
        quantity: line.quantity,
        ...(line.unitAmount.trim() ? { unitAmount: line.unitAmount.trim() } : {}),
        ...(line.discountPercent.trim() ? { discountPercent: line.discountPercent.trim() } : {}),
        taxRateId: line.taxRateId || null,
      })),
    };
    let savedId: string | null = null;
    const ok = await run(
      async () => {
        const path = `/app/orgs/${organizationId}/commerce/${plural}`;
        const result = document
          ? await apiRequest<Record<string, { id: string }>>(`${path}/${document.id}`, {
              method: 'PATCH',
              body,
            })
          : await apiRequest<Record<string, { id: string }>>(path, { body });
        savedId = result[kind]?.id ?? null;
      },
      { refresh: false },
    );
    const id = savedId as string | null;
    if (ok && id) router.push(`/o/${organizationId}/commerce/${plural}/${id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-6" data-testid="document-editor">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        <RecordPicker
          label={m.commerce.customer}
          type="contact"
          value={contact}
          onChange={setContact}
          error={error?.fieldError('contactId')}
        />
        <RecordPicker label={m.commerce.deal} type="deal" value={deal} onChange={setDeal} />
        <SelectField
          label={m.commerce.currency}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
          error={error?.fieldError('currency')}
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
        <TextField
          type="date"
          label={kind === 'invoice' ? m.commerce.dueDate : m.commerce.validUntil}
          hint={kind === 'invoice' ? m.commerce.dueDateHint : m.commerce.validUntilHint}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.commerce.lines}</h2>
        <div className="space-y-4">
          {lines.map((line, index) => {
            const product = liveProducts.find((entry) => entry.id === line.productId);
            const price = product?.prices.find((entry) => entry.currency === currency);
            const fieldError = (key: string) => error?.fieldError(`lines.${index}.${key}`);
            return (
              <div
                key={line.key}
                className="grid gap-3 border-b border-slate-100 pb-4 last:border-0 sm:grid-cols-12"
                data-testid="line-editor"
              >
                <label className="space-y-1.5 sm:col-span-3">
                  <span className="block text-sm font-medium text-slate-800">
                    {m.commerce.line.product}
                  </span>
                  <select
                    className={inputClass}
                    value={line.productId}
                    onChange={(event) => pickProduct(line.key, event.target.value)}
                    aria-invalid={fieldError('productId') ? true : undefined}
                  >
                    <option value="">{m.commerce.line.noProduct}</option>
                    {liveProducts.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField
                  className="sm:col-span-4"
                  label={m.commerce.line.description}
                  value={line.description}
                  onChange={(event) => update(line.key, { description: event.target.value })}
                  required
                  maxLength={1000}
                  error={fieldError('description')}
                />
                <TextField
                  className="sm:col-span-1"
                  label={m.commerce.line.quantity}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                  required
                  error={fieldError('quantity')}
                />
                <TextField
                  className="sm:col-span-2"
                  label={m.commerce.line.unitAmount}
                  inputMode="decimal"
                  value={line.unitAmount}
                  placeholder={price ? price.unitAmount.amount : ''}
                  hint={price ? formatMoney(price.unitAmount) : undefined}
                  onChange={(event) => update(line.key, { unitAmount: event.target.value })}
                  error={fieldError('unitAmount')}
                />
                <TextField
                  className="sm:col-span-1"
                  label={m.commerce.line.discount}
                  inputMode="decimal"
                  value={line.discountPercent}
                  onChange={(event) => update(line.key, { discountPercent: event.target.value })}
                  error={fieldError('discountPercent')}
                />
                <label className="space-y-1.5 sm:col-span-1">
                  <span className="block text-sm font-medium text-slate-800">
                    {m.commerce.line.tax}
                  </span>
                  <select
                    className={inputClass}
                    value={line.taxRateId}
                    onChange={(event) => update(line.key, { taxRateId: event.target.value })}
                  >
                    <option value="">{m.commerce.line.noTax}</option>
                    {liveTaxes.map((rate) => (
                      <option key={rate.id} value={rate.id}>
                        {rate.name} {rate.percent}%
                      </option>
                    ))}
                  </select>
                </label>
                {lines.length > 1 ? (
                  <div className="sm:col-span-12">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setLines((current) => current.filter((entry) => entry.key !== line.key))
                      }
                    >
                      {m.commerce.line.remove}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            disabled={lines.length >= 200}
          >
            {m.commerce.addLine}
          </Button>
          <p className="text-xs text-slate-500">{m.commerce.totalsOnSave}</p>
        </div>
      </section>

      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        <TextAreaField
          label={m.commerce.notes}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          maxLength={5000}
        />
        <TextAreaField
          label={m.commerce.terms}
          value={terms}
          onChange={(event) => setTerms(event.target.value)}
          rows={3}
          maxLength={5000}
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={!contact}>
          {m.commerce.save}
        </Button>
      </div>
    </form>
  );
}
