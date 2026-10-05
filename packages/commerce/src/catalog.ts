import type { CrmContext } from '@businessos/crm';
import {
  commerceProductPrices,
  commerceProducts,
  commerceSettings,
  commerceTaxRates,
  isUniqueViolation,
  PRODUCT_KINDS,
  type CommerceProduct,
  type CommerceSettings,
  type CommerceTaxRate,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { bpToPercent, moneyView, parseUnitAmount, percentSchema, type MoneyView } from './money';

// ── Settings and numbering ──────────────────────────────────────────────────────────────

const prefixSchema = z
  .string()
  .max(20)
  .regex(/^[A-Za-z0-9/_-]*$/, 'Letters, digits, -, _ and /');

export const settingsInputSchema = z
  .object({
    invoicePrefix: prefixSchema,
    quotePrefix: prefixSchema,
    nextInvoiceNumber: z.number().int().min(1).max(1_000_000_000),
    nextQuoteNumber: z.number().int().min(1).max(1_000_000_000),
    defaultDueDays: z.number().int().min(0).max(365),
    invoiceFooter: z.string().trim().max(2_000).nullable(),
  })
  .partial();

export interface SettingsView {
  invoicePrefix: string;
  quotePrefix: string;
  nextInvoiceNumber: number;
  nextQuoteNumber: number;
  defaultDueDays: number;
  invoiceFooter: string | null;
}

function settingsView(row: CommerceSettings): SettingsView {
  return {
    invoicePrefix: row.invoicePrefix,
    quotePrefix: row.quotePrefix,
    nextInvoiceNumber: Number(row.nextInvoiceNumber),
    nextQuoteNumber: Number(row.nextQuoteNumber),
    defaultDueDays: row.defaultDueDays,
    invoiceFooter: row.invoiceFooter,
  };
}

export async function getSettingsRow(
  tx: TenantTx,
  organizationId: string,
): Promise<CommerceSettings> {
  await tx.insert(commerceSettings).values({ organizationId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(commerceSettings)
    .where(eq(commerceSettings.organizationId, organizationId));
  if (!row) throw new Error('commerce settings missing');
  return row;
}

export async function getSettings(tx: TenantTx, organizationId: string): Promise<SettingsView> {
  return settingsView(await getSettingsRow(tx, organizationId));
}

/** Numbers can only move forward: an issued number is never handed out again. */
export async function updateSettings(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof settingsInputSchema>,
): Promise<{ settings: SettingsView; changedFields: string[] }> {
  const input = settingsInputSchema.parse(rawInput);
  await getSettingsRow(tx, ctx.organizationId);
  const [current] = await tx
    .select()
    .from(commerceSettings)
    .where(eq(commerceSettings.organizationId, ctx.organizationId))
    .for('update');
  if (!current) throw new Error('commerce settings missing');
  const problems = [];
  if (
    input.nextInvoiceNumber !== undefined &&
    BigInt(input.nextInvoiceNumber) < current.nextInvoiceNumber
  ) {
    problems.push({ path: 'nextInvoiceNumber', message: 'Numbers can only move forward' });
  }
  if (
    input.nextQuoteNumber !== undefined &&
    BigInt(input.nextQuoteNumber) < current.nextQuoteNumber
  ) {
    problems.push({ path: 'nextQuoteNumber', message: 'Numbers can only move forward' });
  }
  if (problems.length > 0) throw new ValidationError('Invalid numbering', problems);
  const set: Partial<typeof commerceSettings.$inferInsert> = {};
  if (input.invoicePrefix !== undefined) set.invoicePrefix = input.invoicePrefix;
  if (input.quotePrefix !== undefined) set.quotePrefix = input.quotePrefix;
  if (input.nextInvoiceNumber !== undefined)
    set.nextInvoiceNumber = BigInt(input.nextInvoiceNumber);
  if (input.nextQuoteNumber !== undefined) set.nextQuoteNumber = BigInt(input.nextQuoteNumber);
  if (input.defaultDueDays !== undefined) set.defaultDueDays = input.defaultDueDays;
  if (input.invoiceFooter !== undefined) set.invoiceFooter = input.invoiceFooter;
  const changedFields = Object.keys(set);
  if (changedFields.length > 0) {
    await tx
      .update(commerceSettings)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(commerceSettings.organizationId, ctx.organizationId));
  }
  return { settings: await getSettings(tx, ctx.organizationId), changedFields };
}

/**
 * Takes the next document number inside the caller's transaction (the settings row is locked
 * until it commits), so issued numbers are unique and gapless: a rolled-back issue returns its
 * number.
 */
export async function allocateNumber(
  tx: TenantTx,
  organizationId: string,
  kind: 'invoice' | 'quote',
): Promise<string> {
  await getSettingsRow(tx, organizationId);
  const column =
    kind === 'invoice' ? commerceSettings.nextInvoiceNumber : commerceSettings.nextQuoteNumber;
  const [row] = await tx
    .update(commerceSettings)
    .set(
      kind === 'invoice'
        ? { nextInvoiceNumber: sql`${column} + 1` }
        : { nextQuoteNumber: sql`${column} + 1` },
    )
    .where(eq(commerceSettings.organizationId, organizationId))
    .returning({
      prefix: kind === 'invoice' ? commerceSettings.invoicePrefix : commerceSettings.quotePrefix,
      next: column,
    });
  if (!row) throw new Error('commerce settings missing');
  const value = row.next - 1n;
  return `${row.prefix}${value.toString().padStart(6, '0')}`;
}

// ── Tax rates ───────────────────────────────────────────────────────────────────────────

export const taxRateInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  percent: percentSchema,
});

export interface TaxRateView {
  id: string;
  name: string;
  percent: string;
  rateBp: number;
  archived: boolean;
}

export function taxRateView(row: CommerceTaxRate): TaxRateView {
  return {
    id: row.id,
    name: row.name,
    percent: bpToPercent(row.rateBp),
    rateBp: row.rateBp,
    archived: row.archivedAt !== null,
  };
}

export async function listTaxRates(
  tx: TenantTx,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<TaxRateView[]> {
  const conditions = [eq(commerceTaxRates.organizationId, organizationId)];
  if (!options.includeArchived) conditions.push(isNull(commerceTaxRates.archivedAt));
  const rows = await tx
    .select()
    .from(commerceTaxRates)
    .where(and(...conditions))
    .orderBy(asc(commerceTaxRates.name))
    .limit(200);
  return rows.map(taxRateView);
}

export async function getTaxRateRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<CommerceTaxRate> {
  const [row] = await tx
    .select()
    .from(commerceTaxRates)
    .where(and(eq(commerceTaxRates.id, id), eq(commerceTaxRates.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Tax rate');
  return row;
}

export async function createTaxRate(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof taxRateInputSchema>,
): Promise<TaxRateView> {
  const input = taxRateInputSchema.parse(rawInput);
  const [row] = await tx
    .insert(commerceTaxRates)
    .values({ organizationId: ctx.organizationId, name: input.name, rateBp: input.percent })
    .returning();
  if (!row) throw new Error('tax rate insert returned no row');
  return taxRateView(row);
}

/** The rate itself never changes (create a new rate instead); names can, and rates archive. */
export async function updateTaxRate(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: { name?: string; archived?: boolean },
): Promise<TaxRateView> {
  const input = z
    .object({ name: z.string().trim().min(1).max(60), archived: z.boolean() })
    .partial()
    .parse(rawInput);
  await getTaxRateRow(tx, ctx.organizationId, id);
  const [row] = await tx
    .update(commerceTaxRates)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(commerceTaxRates.id, id), eq(commerceTaxRates.organizationId, ctx.organizationId)),
    )
    .returning();
  if (!row) throw new NotFoundError('Tax rate');
  return taxRateView(row);
}

// ── Products and prices ─────────────────────────────────────────────────────────────────

const priceInputSchema = z.object({
  currency: z.string().trim().toUpperCase().length(3),
  amount: z.string().trim().max(40),
});

const productFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  sku: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  kind: z.enum(PRODUCT_KINDS).optional(),
  taxRateId: z.uuid().nullable().optional(),
  prices: z
    .array(priceInputSchema)
    .max(20)
    .refine(
      (prices) => new Set(prices.map((price) => price.currency)).size === prices.length,
      'One price per currency',
    )
    .optional(),
};

export const createProductInputSchema = z.object(productFields);
export const updateProductInputSchema = z
  .object({ ...productFields, archived: z.boolean() })
  .partial();
export const productListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export interface ProductView {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  kind: CommerceProduct['kind'];
  taxRate: TaxRateView | null;
  prices: { id: string; currency: string; unitAmount: MoneyView }[];
  archived: boolean;
}

async function productViews(
  tx: TenantTx,
  organizationId: string,
  rows: CommerceProduct[],
): Promise<ProductView[]> {
  const ids = rows.map((row) => row.id);
  const prices =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(commerceProductPrices)
          .where(
            and(
              eq(commerceProductPrices.organizationId, organizationId),
              inArray(commerceProductPrices.productId, ids),
              isNull(commerceProductPrices.archivedAt),
            ),
          )
          .orderBy(asc(commerceProductPrices.currency));
  const taxIds = [
    ...new Set(rows.map((row) => row.taxRateId).filter((id): id is string => id !== null)),
  ];
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
            ),
          );
  return rows.map((row) => {
    const tax = taxes.find((entry) => entry.id === row.taxRateId);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sku: row.sku,
      kind: row.kind,
      taxRate: tax ? taxRateView(tax) : null,
      prices: prices
        .filter((price) => price.productId === row.id)
        .map((price) => ({
          id: price.id,
          currency: price.currency,
          unitAmount: moneyView(price.unitAmountMinor, price.currency),
        })),
      archived: row.archivedAt !== null,
    };
  });
}

export async function getProductRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<CommerceProduct> {
  const [row] = await tx
    .select()
    .from(commerceProducts)
    .where(and(eq(commerceProducts.id, id), eq(commerceProducts.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Product');
  return row;
}

export async function getProduct(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<ProductView> {
  const [view] = await productViews(tx, organizationId, [
    await getProductRow(tx, organizationId, id),
  ]);
  if (!view) throw new NotFoundError('Product');
  return view;
}

export async function listProducts(
  tx: TenantTx,
  organizationId: string,
  rawQuery: z.input<typeof productListQuerySchema> = {},
): Promise<{ data: ProductView[] }> {
  const query = productListQuerySchema.parse(rawQuery);
  const conditions = [eq(commerceProducts.organizationId, organizationId)];
  if (!query.includeArchived) conditions.push(isNull(commerceProducts.archivedAt));
  if (query.q) {
    conditions.push(
      ilike(commerceProducts.name, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
    );
  }
  const rows = await tx
    .select()
    .from(commerceProducts)
    .where(and(...conditions))
    .orderBy(asc(sql`lower(${commerceProducts.name})`), asc(commerceProducts.id))
    .limit(query.limit);
  return { data: await productViews(tx, organizationId, rows) };
}

async function assertTaxRate(tx: TenantTx, organizationId: string, id: string | null | undefined) {
  if (!id) return;
  const row = await getTaxRateRow(tx, organizationId, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      throw new ValidationError('Unknown tax rate', [
        { path: 'taxRateId', message: 'Tax rate not found' },
      ]);
    }
    throw error;
  });
  if (row.archivedAt) {
    throw new ValidationError('Archived tax rate', [
      { path: 'taxRateId', message: 'This tax rate is archived' },
    ]);
  }
}

/** Replaces the live prices: unchanged ones stay, changed or removed ones are archived. */
async function setPrices(
  tx: TenantTx,
  organizationId: string,
  productId: string,
  prices: z.infer<typeof priceInputSchema>[],
): Promise<void> {
  const parsed = prices.map((price, index) => ({
    currency: price.currency,
    amountMinor: parseUnitAmount(price.amount, price.currency, `prices.${index}.amount`),
  }));
  const live = await tx
    .select()
    .from(commerceProductPrices)
    .where(
      and(
        eq(commerceProductPrices.organizationId, organizationId),
        eq(commerceProductPrices.productId, productId),
        isNull(commerceProductPrices.archivedAt),
      ),
    );
  const now = new Date();
  for (const existing of live) {
    const wanted = parsed.find((price) => price.currency === existing.currency);
    if (wanted?.amountMinor === existing.unitAmountMinor) continue;
    await tx
      .update(commerceProductPrices)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(commerceProductPrices.id, existing.id),
          eq(commerceProductPrices.organizationId, organizationId),
        ),
      );
  }
  for (const price of parsed) {
    const kept = live.find(
      (existing) =>
        existing.currency === price.currency && existing.unitAmountMinor === price.amountMinor,
    );
    if (kept) continue;
    await tx.insert(commerceProductPrices).values({
      organizationId,
      productId,
      currency: price.currency,
      unitAmountMinor: price.amountMinor,
    });
  }
}

function translateSkuConflict(error: unknown): never {
  if (isUniqueViolation(error, 'commerce_products_sku_unique')) {
    throw new ConflictError('Another product has this SKU', {
      details: [{ path: 'sku', message: 'Already used' }],
    });
  }
  throw error;
}

export async function createProduct(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createProductInputSchema>,
): Promise<ProductView> {
  const input = createProductInputSchema.parse(rawInput);
  await assertTaxRate(tx, ctx.organizationId, input.taxRateId);
  let row: CommerceProduct | undefined;
  try {
    [row] = await tx.transaction((sp) =>
      sp
        .insert(commerceProducts)
        .values({
          organizationId: ctx.organizationId,
          name: input.name,
          description: input.description ?? null,
          sku: input.sku ?? null,
          kind: input.kind ?? 'service',
          taxRateId: input.taxRateId ?? null,
        })
        .returning(),
    );
  } catch (error) {
    translateSkuConflict(error);
  }
  if (!row) throw new Error('product insert returned no row');
  await setPrices(tx, ctx.organizationId, row.id, input.prices ?? []);
  return getProduct(tx, ctx.organizationId, row.id);
}

export async function updateProduct(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateProductInputSchema>,
): Promise<ProductView> {
  const input = updateProductInputSchema.parse(rawInput);
  await getProductRow(tx, ctx.organizationId, id);
  if (input.taxRateId !== undefined) await assertTaxRate(tx, ctx.organizationId, input.taxRateId);
  const set: Partial<typeof commerceProducts.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.sku !== undefined) set.sku = input.sku;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.taxRateId !== undefined) set.taxRateId = input.taxRateId;
  if (input.archived !== undefined) set.archivedAt = input.archived ? new Date() : null;
  try {
    await tx.transaction((sp) =>
      sp
        .update(commerceProducts)
        .set({ ...set, updatedAt: new Date() })
        .where(
          and(eq(commerceProducts.id, id), eq(commerceProducts.organizationId, ctx.organizationId)),
        ),
    );
  } catch (error) {
    translateSkuConflict(error);
  }
  if (input.prices !== undefined) await setPrices(tx, ctx.organizationId, id, input.prices);
  return getProduct(tx, ctx.organizationId, id);
}
