'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { inputClass, SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { Product, TaxRate } from '@/lib/commerce-types';
import { CURRENCIES } from './document-editor';

interface PriceState {
  key: number;
  currency: string;
  amount: string;
}

let nextKey = 1;

/** Create or edit a product/service and its prices (one per currency). */
export function ProductEditor({
  product,
  taxRates,
  defaultCurrency,
}: {
  product?: Product;
  taxRates: TaxRate[];
  defaultCurrency: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [kind, setKind] = useState<Product['kind']>(product?.kind ?? 'service');
  const [taxRateId, setTaxRateId] = useState(product?.taxRate?.id ?? '');
  const [prices, setPrices] = useState<PriceState[]>(
    product?.prices.map((price) => ({
      key: nextKey++,
      currency: price.currency,
      amount: price.unitAmount.amount,
    })) ?? [{ key: nextKey++, currency: defaultCurrency, amount: '' }],
  );
  const path = `/app/orgs/${organizationId}/commerce/products`;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      name,
      sku: sku.trim() || null,
      kind,
      taxRateId: taxRateId || null,
      prices: prices
        .filter((price) => price.amount.trim() !== '')
        .map((price) => ({ currency: price.currency, amount: price.amount.trim() })),
    };
    const ok = await run(() =>
      product
        ? apiRequest(`${path}/${product.id}`, { method: 'PATCH', body })
        : apiRequest(path, { body }),
    );
    if (ok) {
      setOpen(false);
      if (!product) {
        setName('');
        setSku('');
        setPrices([{ key: nextKey++, currency: defaultCurrency, amount: '' }]);
      }
    }
  }

  return (
    <>
      <Button
        variant={product ? 'ghost' : 'primary'}
        size={product ? 'sm' : 'md'}
        onClick={() => setOpen(true)}
      >
        {product ? m.commerce.edit : m.commerce.newProduct}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={product ? m.commerce.editProduct : m.commerce.newProduct}
      >
        <form onSubmit={submit} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={m.commerce.productName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={200}
            error={error?.fieldError('name')}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={m.commerce.sku}
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              maxLength={60}
              error={error?.fieldError('sku')}
            />
            <SelectField
              label={m.commerce.kind}
              value={kind}
              onChange={(event) => setKind(event.target.value as Product['kind'])}
            >
              <option value="service">{m.commerce.kinds.service}</option>
              <option value="product">{m.commerce.kinds.product}</option>
            </SelectField>
          </div>
          <SelectField
            label={m.commerce.defaultTax}
            value={taxRateId}
            onChange={(event) => setTaxRateId(event.target.value)}
          >
            <option value="">{m.commerce.line.noTax}</option>
            {taxRates
              .filter((rate) => !rate.archived || rate.id === taxRateId)
              .map((rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.name} {rate.percent}%
                </option>
              ))}
          </SelectField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">{m.commerce.prices}</legend>
            <p className="text-xs text-slate-500">{m.commerce.pricesHint}</p>
            {prices.map((price, index) => (
              <div key={price.key} className="flex items-start gap-2">
                <select
                  aria-label={m.commerce.currency}
                  className={`${inputClass} w-28`}
                  value={price.currency}
                  onChange={(event) =>
                    setPrices((current) =>
                      current.map((entry) =>
                        entry.key === price.key
                          ? { ...entry, currency: event.target.value }
                          : entry,
                      ),
                    )
                  }
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
                <div className="flex-1">
                  <input
                    aria-label={m.commerce.price}
                    inputMode="decimal"
                    className={inputClass}
                    value={price.amount}
                    onChange={(event) =>
                      setPrices((current) =>
                        current.map((entry) =>
                          entry.key === price.key
                            ? { ...entry, amount: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  {error?.fieldError(`prices.${index}.amount`) ? (
                    <p className="mt-1 text-sm text-red-600">
                      {error.fieldError(`prices.${index}.amount`)}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setPrices((current) => current.filter((entry) => entry.key !== price.key))
                  }
                >
                  {m.commerce.removePrice}
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setPrices((current) => [
                  ...current,
                  { key: nextKey++, currency: defaultCurrency, amount: '' },
                ])
              }
              disabled={prices.length >= 20}
            >
              {m.commerce.addPrice}
            </Button>
          </fieldset>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Archive or restore a product (kept for existing documents). */
export function ProductArchiveButton({ product }: { product: Product }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending } = useMutation();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() =>
        void run(() =>
          apiRequest(`/app/orgs/${organizationId}/commerce/products/${product.id}`, {
            method: 'PATCH',
            body: { archived: !product.archived },
          }),
        )
      }
    >
      {product.archived ? m.commerce.restore : m.commerce.archive}
    </Button>
  );
}
