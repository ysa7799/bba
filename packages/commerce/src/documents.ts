import {
  assertCompanyExists,
  assertContactExists,
  assertDealExists,
  displayName,
} from '@businessos/crm';
import {
  commerceProductPrices,
  commerceProducts,
  commerceTaxRates,
  crmCompanies,
  crmContacts,
  type CommerceLineItem,
  type TenantTx,
} from '@businessos/database';
import { currencyCodeSchema, ValidationError, type ErrorDetail } from '@businessos/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  bpToPercent,
  computeLine,
  computeTotals,
  moneyView,
  parseUnitAmount,
  percentSchema,
  quantitySchema,
  type DocumentTotals,
  type LineAmounts,
  type MoneyView,
} from './money';

export const MAX_LINES = 200;

export const lineInputSchema = z.object({
  productId: z.uuid().nullable().optional(),
  description: z.string().trim().min(1).max(1_000),
  quantity: quantitySchema,
  /** Unit price in the document currency; omitted: the product's price in that currency. */
  unitAmount: z.string().trim().max(40).optional(),
  discountPercent: percentSchema.optional(),
  taxRateId: z.uuid().nullable().optional(),
});
export type LineInput = z.input<typeof lineInputSchema>;

/**
 * Who and what a document is for. There is deliberately no field for totals, numbers, status or
 * payment state: those are computed or set by the server.
 */
export const documentFields = {
  contactId: z.uuid(),
  companyId: z.uuid().nullable().optional(),
  dealId: z.uuid().nullable().optional(),
  currency: currencyCodeSchema.optional(),
  notes: z.string().trim().max(5_000).nullable().optional(),
  terms: z.string().trim().max(5_000).nullable().optional(),
  lines: z.array(lineInputSchema).min(1).max(MAX_LINES),
};

export interface BuiltLine extends LineAmounts {
  position: number;
  productId: string | null;
  description: string;
  quantity: string;
  unitAmountMinor: bigint;
  discountBp: number;
  taxRateId: string | null;
  taxName: string | null;
  taxRateBp: number;
}

/**
 * Resolves products and tax rates (live records of this organization only), snapshots tax
 * names and rates, and computes every amount on the server.
 */
export async function buildLines(
  tx: TenantTx,
  organizationId: string,
  currency: string,
  inputs: z.infer<typeof lineInputSchema>[],
): Promise<{ lines: BuiltLine[]; totals: DocumentTotals }> {
  const productIds = [
    ...new Set(inputs.map((line) => line.productId).filter((id): id is string => Boolean(id))),
  ];
  const taxIds = [
    ...new Set(inputs.map((line) => line.taxRateId).filter((id): id is string => Boolean(id))),
  ];
  const products =
    productIds.length === 0
      ? []
      : await tx
          .select()
          .from(commerceProducts)
          .where(
            and(
              eq(commerceProducts.organizationId, organizationId),
              inArray(commerceProducts.id, productIds),
              isNull(commerceProducts.archivedAt),
            ),
          );
  const prices =
    productIds.length === 0
      ? []
      : await tx
          .select()
          .from(commerceProductPrices)
          .where(
            and(
              eq(commerceProductPrices.organizationId, organizationId),
              inArray(commerceProductPrices.productId, productIds),
              eq(commerceProductPrices.currency, currency),
              isNull(commerceProductPrices.archivedAt),
            ),
          );
  const taxes =
    taxIds.length === 0
      ? []
      : await tx
          .select()
          .from(commerceTaxRates)
          .where(
            and(
              eq(commerceTaxRates.organizationId, organizationId),
              inArray(commerceTaxRates.id, taxIds),
              isNull(commerceTaxRates.archivedAt),
            ),
          );
  const problems: ErrorDetail[] = [];
  const lines: BuiltLine[] = [];
  inputs.forEach((input, index) => {
    const path = (key: string) => `lines.${index}.${key}`;
    if (input.productId && !products.some((product) => product.id === input.productId)) {
      problems.push({ path: path('productId'), message: 'Product not found' });
      return;
    }
    const tax = input.taxRateId ? taxes.find((entry) => entry.id === input.taxRateId) : undefined;
    if (input.taxRateId && !tax) {
      problems.push({ path: path('taxRateId'), message: 'Tax rate not found' });
      return;
    }
    let unitAmountMinor: bigint;
    if (input.unitAmount !== undefined && input.unitAmount !== '') {
      try {
        unitAmountMinor = parseUnitAmount(input.unitAmount, currency, path('unitAmount'));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        problems.push(...(error.details ?? []));
        return;
      }
    } else {
      const price = prices.find((entry) => entry.productId === input.productId);
      if (!price) {
        problems.push({
          path: path('unitAmount'),
          message: input.productId ? `The product has no ${currency} price` : 'Enter a price',
        });
        return;
      }
      unitAmountMinor = price.unitAmountMinor;
    }
    const discountBp = input.discountPercent ?? 0;
    const taxRateBp = tax?.rateBp ?? 0;
    lines.push({
      position: index,
      productId: input.productId ?? null,
      description: input.description,
      quantity: input.quantity,
      unitAmountMinor,
      discountBp,
      taxRateId: tax?.id ?? null,
      taxName: tax?.name ?? null,
      taxRateBp,
      ...computeLine({ quantity: input.quantity, unitAmountMinor, discountBp, taxRateBp }),
    });
  });
  if (problems.length > 0) throw new ValidationError('Please check the lines', problems);
  return { lines, totals: computeTotals(lines) };
}

export function lineValues(organizationId: string, line: BuiltLine) {
  return {
    organizationId,
    position: line.position,
    productId: line.productId,
    description: line.description,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmountMinor,
    discountBp: line.discountBp,
    taxRateId: line.taxRateId,
    taxName: line.taxName,
    taxRateBp: line.taxRateBp,
    subtotalMinor: line.subtotalMinor,
    discountMinor: line.discountMinor,
    taxMinor: line.taxMinor,
    totalMinor: line.totalMinor,
  };
}

/** The customer and related records must be live records of this organization. */
export async function assertParties(
  tx: TenantTx,
  organizationId: string,
  input: {
    contactId: string;
    companyId?: string | null | undefined;
    dealId?: string | null | undefined;
  },
): Promise<void> {
  const check = async (path: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      throw new ValidationError('Unknown record', [{ path, message: 'Not found' }]);
    }
  };
  await check('contactId', () => assertContactExists(tx, organizationId, input.contactId));
  const companyId = input.companyId;
  if (companyId) await check('companyId', () => assertCompanyExists(tx, organizationId, companyId));
  const dealId = input.dealId;
  if (dealId) await check('dealId', () => assertDealExists(tx, organizationId, dealId));
}

export interface LineView {
  id: string;
  position: number;
  productId: string | null;
  description: string;
  quantity: string;
  unitAmount: MoneyView;
  discountPercent: string;
  tax: { id: string | null; name: string; percent: string } | null;
  subtotal: MoneyView;
  discount: MoneyView;
  taxAmount: MoneyView;
  total: MoneyView;
}

export function lineView(row: Omit<CommerceLineItem, 'invoiceId'>, currency: string): LineView {
  return {
    id: row.id,
    position: row.position,
    productId: row.productId,
    description: row.description,
    quantity: row.quantity.replace(/\.?0+$/, '') || '0',
    unitAmount: moneyView(row.unitAmountMinor, currency),
    discountPercent: bpToPercent(row.discountBp),
    tax:
      row.taxName === null
        ? null
        : { id: row.taxRateId, name: row.taxName, percent: bpToPercent(row.taxRateBp) },
    subtotal: moneyView(row.subtotalMinor, currency),
    discount: moneyView(row.discountMinor, currency),
    taxAmount: moneyView(row.taxMinor, currency),
    total: moneyView(row.totalMinor, currency),
  };
}

export interface PartyView {
  contact: { id: string; name: string; email: string | null } | null;
  company: { id: string; name: string } | null;
}

/** Customer names for documents (contact details only for readers who may see contacts). */
export async function partiesOf(
  tx: TenantTx,
  organizationId: string,
  rows: { contactId: string; companyId: string | null }[],
  canSeeContacts = true,
): Promise<Map<string, PartyView>> {
  const contactIds = [...new Set(rows.map((row) => row.contactId))];
  const companyIds = [
    ...new Set(rows.map((row) => row.companyId).filter((id): id is string => id !== null)),
  ];
  const contacts =
    contactIds.length === 0 || !canSeeContacts
      ? []
      : await tx
          .select()
          .from(crmContacts)
          .where(
            and(
              eq(crmContacts.organizationId, organizationId),
              inArray(crmContacts.id, contactIds),
            ),
          );
  const companies =
    companyIds.length === 0
      ? []
      : await tx
          .select({ id: crmCompanies.id, name: crmCompanies.name })
          .from(crmCompanies)
          .where(
            and(
              eq(crmCompanies.organizationId, organizationId),
              inArray(crmCompanies.id, companyIds),
            ),
          );
  const out = new Map<string, PartyView>();
  for (const row of rows) {
    const contact = contacts.find((entry) => entry.id === row.contactId);
    out.set(`${row.contactId}:${row.companyId ?? ''}`, {
      contact: contact
        ? { id: contact.id, name: displayName(contact), email: contact.email }
        : null,
      company: companies.find((entry) => entry.id === row.companyId) ?? null,
    });
  }
  return out;
}

export function partyKey(row: { contactId: string; companyId: string | null }): string {
  return `${row.contactId}:${row.companyId ?? ''}`;
}

export interface TotalsView {
  subtotal: MoneyView;
  discount: MoneyView;
  tax: MoneyView;
  total: MoneyView;
}

export function totalsView(
  row: { subtotalMinor: bigint; discountMinor: bigint; taxMinor: bigint; totalMinor: bigint },
  currency: string,
): TotalsView {
  return {
    subtotal: moneyView(row.subtotalMinor, currency),
    discount: moneyView(row.discountMinor, currency),
    tax: moneyView(row.taxMinor, currency),
    total: moneyView(row.totalMinor, currency),
  };
}

/** Who receives a document by email (the customer contact of this organization). */
export async function recipientOf(
  tx: TenantTx,
  organizationId: string,
  contactId: string,
): Promise<{ name: string; email: string | null }> {
  const [contact] = await tx
    .select()
    .from(crmContacts)
    .where(and(eq(crmContacts.organizationId, organizationId), eq(crmContacts.id, contactId)));
  return { name: contact ? displayName(contact) : '', email: contact?.email ?? null };
}
