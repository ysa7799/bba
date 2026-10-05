import { eventMeta, type CrmContext } from '@businessos/crm';
import {
  commerceInvoiceItems,
  commerceInvoices,
  commerceQuoteItems,
  commerceQuotes,
  organizations,
  withSystem,
  withTenant,
  type CommerceQuote,
  type Database,
  type TenantTx,
  type Tx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  ConflictError,
  decodeCursor,
  encodeCursor,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { allocateNumber, getSettingsRow } from './catalog';
import {
  assertParties,
  buildLines,
  documentFields,
  lineValues,
  lineView,
  partiesOf,
  partyKey,
  totalsView,
  type LineView,
  type PartyView,
  type TotalsView,
} from './documents';
import {
  addDaysToDate,
  DOCUMENT_TOKEN,
  getInvoice,
  hashDocumentToken,
  localDate,
  newDocumentToken,
  type EventMeta,
  type InvoiceDetail,
} from './invoices';

/** Quotes are valid for 30 days unless the quote says otherwise. */
export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;

export const createQuoteInputSchema = z.object({
  ...documentFields,
  validUntil: z.iso.date().nullable().optional(),
});
export const updateQuoteInputSchema = createQuoteInputSchema.partial();
export const quoteListQuerySchema = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'declined', 'expired', 'converted']).optional(),
  contactId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const quoteResponseSchema = z.object({ decision: z.enum(['accept', 'decline']) });

export interface QuoteSummary extends PartyView, TotalsView {
  id: string;
  number: string;
  status: CommerceQuote['status'];
  currency: string;
  dealId: string | null;
  issueDate: string;
  validUntil: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  convertedInvoiceId: string | null;
  createdAt: string;
}

export interface QuoteDetail extends QuoteSummary {
  notes: string | null;
  terms: string | null;
  lines: LineView[];
}

async function summaries(
  tx: TenantTx,
  ctx: CrmContext,
  rows: CommerceQuote[],
): Promise<QuoteSummary[]> {
  const parties = await partiesOf(tx, ctx.organizationId, rows, ctx.canRead?.contact ?? true);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    ...(parties.get(partyKey(row)) ?? { contact: null, company: null }),
    dealId: row.dealId,
    issueDate: row.issueDate,
    validUntil: row.validUntil,
    ...totalsView(row, row.currency),
    sentAt: row.sentAt?.toISOString() ?? null,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    convertedInvoiceId: row.convertedInvoiceId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getQuoteRow(
  tx: Tx,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<CommerceQuote> {
  const query = tx
    .select()
    .from(commerceQuotes)
    .where(and(eq(commerceQuotes.id, id), eq(commerceQuotes.organizationId, organizationId)));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Quote');
  return row;
}

async function quoteLines(tx: Tx, quote: CommerceQuote) {
  return tx
    .select()
    .from(commerceQuoteItems)
    .where(
      and(
        eq(commerceQuoteItems.quoteId, quote.id),
        eq(commerceQuoteItems.organizationId, quote.organizationId),
      ),
    )
    .orderBy(asc(commerceQuoteItems.position));
}

export async function getQuote(tx: TenantTx, ctx: CrmContext, id: string): Promise<QuoteDetail> {
  const row = await getQuoteRow(tx, ctx.organizationId, id);
  const [summary] = await summaries(tx, ctx, [row]);
  if (!summary) throw new NotFoundError('Quote');
  return {
    ...summary,
    notes: row.notes,
    terms: row.terms,
    lines: (await quoteLines(tx, row)).map((line) => lineView(line, row.currency)),
  };
}

export async function listQuotes(
  tx: TenantTx,
  ctx: CrmContext,
  rawQuery: z.input<typeof quoteListQuerySchema>,
): Promise<{ data: QuoteSummary[]; nextCursor: string | null }> {
  const query = quoteListQuerySchema.parse(rawQuery);
  const conditions: SQL[] = [eq(commerceQuotes.organizationId, ctx.organizationId)];
  if (query.status) conditions.push(eq(commerceQuotes.status, query.status));
  if (query.contactId) conditions.push(eq(commerceQuotes.contactId, query.contactId));
  if (query.dealId) conditions.push(eq(commerceQuotes.dealId, query.dealId));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, z.object({ v: z.string().max(40), id: z.uuid() }));
    conditions.push(
      sql`(${commerceQuotes.createdAt}, ${commerceQuotes.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({ row: commerceQuotes, sortValue: sql<string>`${commerceQuotes.createdAt}::text` })
    .from(commerceQuotes)
    .where(and(...conditions))
    .orderBy(desc(commerceQuotes.createdAt), desc(commerceQuotes.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: await summaries(
      tx,
      ctx,
      page.map((entry) => entry.row),
    ),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: last.sortValue, id: last.row.id })
        : null,
  };
}

async function writeQuoteLines(
  tx: TenantTx,
  organizationId: string,
  quoteId: string,
  lines: Awaited<ReturnType<typeof buildLines>>['lines'],
): Promise<void> {
  await tx
    .delete(commerceQuoteItems)
    .where(
      and(
        eq(commerceQuoteItems.quoteId, quoteId),
        eq(commerceQuoteItems.organizationId, organizationId),
      ),
    );
  await tx
    .insert(commerceQuoteItems)
    .values(lines.map((line) => ({ ...lineValues(organizationId, line), quoteId })));
}

/** Creates a draft quote. Quotes are numbered on creation (a deleted draft leaves a gap). */
export async function createQuote(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createQuoteInputSchema>,
): Promise<QuoteDetail> {
  const input = createQuoteInputSchema.parse(rawInput);
  const currency = input.currency ?? ctx.defaultCurrency;
  await assertParties(tx, ctx.organizationId, input);
  const { lines, totals } = await buildLines(tx, ctx.organizationId, currency, input.lines);
  const number = await allocateNumber(tx, ctx.organizationId, 'quote');
  const [row] = await tx
    .insert(commerceQuotes)
    .values({
      organizationId: ctx.organizationId,
      number,
      contactId: input.contactId,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      currency,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      issueDate: localDate(new Date(), ctx.timezone),
      validUntil: input.validUntil ?? null,
      ...totals,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!row) throw new Error('quote insert returned no row');
  await writeQuoteLines(tx, ctx.organizationId, row.id, lines);
  return getQuote(tx, ctx, row.id);
}

/** Only drafts can be edited: a sent quote is what the customer saw. */
export async function updateQuote(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateQuoteInputSchema>,
): Promise<QuoteDetail> {
  const input = updateQuoteInputSchema.parse(rawInput);
  const current = await getQuoteRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft') throw new ConflictError('Only draft quotes can be edited');
  const merged = {
    contactId: input.contactId ?? current.contactId,
    companyId: input.companyId === undefined ? current.companyId : input.companyId,
    dealId: input.dealId === undefined ? current.dealId : input.dealId,
  };
  await assertParties(tx, ctx.organizationId, merged);
  const currency = input.currency ?? current.currency;
  if (currency !== current.currency && !input.lines) {
    throw new ValidationError('Re-enter the lines when changing the currency', [
      { path: 'lines', message: 'Prices are per currency' },
    ]);
  }
  let totals = {};
  if (input.lines) {
    const built = await buildLines(tx, ctx.organizationId, currency, input.lines);
    await writeQuoteLines(tx, ctx.organizationId, id, built.lines);
    totals = built.totals;
  }
  await tx
    .update(commerceQuotes)
    .set({
      ...merged,
      currency,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.terms !== undefined ? { terms: input.terms } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...totals,
      updatedAt: new Date(),
    })
    .where(and(eq(commerceQuotes.id, id), eq(commerceQuotes.organizationId, ctx.organizationId)));
  return getQuote(tx, ctx, id);
}

export async function deleteDraftQuote(tx: TenantTx, ctx: CrmContext, id: string): Promise<void> {
  const current = await getQuoteRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft') throw new ConflictError('Only draft quotes can be deleted');
  await tx
    .delete(commerceQuotes)
    .where(and(eq(commerceQuotes.id, id), eq(commerceQuotes.organizationId, ctx.organizationId)));
}

/**
 * Sends (or re-sends) a quote: fixes the issue date and validity and creates a new customer
 * link (a previous link stops working). Returns the link token; only its hash is stored.
 */
export async function sendQuote(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ quote: QuoteDetail; token: string }> {
  const current = await getQuoteRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft' && current.status !== 'sent') {
    throw new ConflictError('This quote can no longer be sent');
  }
  if (current.totalMinor <= 0n) {
    throw new ValidationError('A quote needs a total above zero', [
      { path: 'lines', message: 'Total is zero' },
    ]);
  }
  const today = localDate(new Date(), ctx.timezone);
  const issueDate = current.status === 'draft' ? today : current.issueDate;
  const validUntil =
    current.validUntil && current.validUntil >= today
      ? current.validUntil
      : addDaysToDate(today, DEFAULT_QUOTE_VALIDITY_DAYS);
  const { token, hash } = newDocumentToken();
  const now = new Date();
  await tx
    .update(commerceQuotes)
    .set({
      status: 'sent',
      issueDate,
      validUntil,
      publicTokenHash: hash,
      sentAt: now,
      updatedAt: now,
    })
    .where(and(eq(commerceQuotes.id, id), eq(commerceQuotes.organizationId, ctx.organizationId)));
  if (current.status === 'draft') {
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'quote.sent',
      subject: { type: 'quote', id },
      payload: { quoteId: id, contactId: current.contactId },
    });
  }
  return { quote: await getQuote(tx, ctx, id), token };
}

async function applyResponse(
  tx: Tx,
  quote: CommerceQuote,
  decision: 'accept' | 'decline',
  by: 'customer' | 'staff',
  meta: EventMeta,
  today: string,
): Promise<void> {
  if (quote.status !== 'sent') throw new ConflictError('This quote is not awaiting a response');
  if (quote.validUntil !== null && quote.validUntil < today) {
    throw new ConflictError('This quote has expired');
  }
  const status = decision === 'accept' ? 'accepted' : 'declined';
  await tx
    .update(commerceQuotes)
    .set({ status, respondedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(commerceQuotes.id, quote.id), eq(commerceQuotes.organizationId, quote.organizationId)),
    );
  await emitEvent(tx, {
    organizationId: quote.organizationId,
    actor: meta.actor,
    correlationId: meta.correlationId,
    type: decision === 'accept' ? 'quote.accepted' : 'quote.declined',
    subject: { type: 'quote', id: quote.id },
    payload: { quoteId: quote.id, contactId: quote.contactId, by },
  });
}

/** Staff record the customer's answer (e.g. accepted by phone). */
export async function respondToQuote(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof quoteResponseSchema>,
): Promise<QuoteDetail> {
  const { decision } = quoteResponseSchema.parse(rawInput);
  const quote = await getQuoteRow(tx, ctx.organizationId, id, { lock: true });
  const meta = eventMeta(ctx);
  await applyResponse(tx, quote, decision, 'staff', meta, localDate(new Date(), ctx.timezone));
  return getQuote(tx, ctx, id);
}

/**
 * Turns a sent or accepted quote into a draft invoice with the same lines and amounts (the
 * agreed prices and tax snapshots are copied, not recalculated). A quote converts once.
 */
export async function convertQuoteToInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<InvoiceDetail> {
  const quote = await getQuoteRow(tx, ctx.organizationId, id, { lock: true });
  if (quote.status === 'converted') throw new ConflictError('This quote has already been invoiced');
  if (quote.status !== 'accepted' && quote.status !== 'sent') {
    throw new ConflictError('Only sent or accepted quotes can be invoiced');
  }
  const [invoice] = await tx
    .insert(commerceInvoices)
    .values({
      organizationId: ctx.organizationId,
      contactId: quote.contactId,
      companyId: quote.companyId,
      dealId: quote.dealId,
      quoteId: quote.id,
      currency: quote.currency,
      notes: quote.notes,
      terms: quote.terms,
      subtotalMinor: quote.subtotalMinor,
      discountMinor: quote.discountMinor,
      taxMinor: quote.taxMinor,
      totalMinor: quote.totalMinor,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!invoice) throw new Error('invoice insert returned no row');
  const lines = await quoteLines(tx, quote);
  if (lines.length > 0) {
    await tx.insert(commerceInvoiceItems).values(
      lines.map((line) => ({
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
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
      })),
    );
  }
  await tx
    .update(commerceQuotes)
    .set({ status: 'converted', convertedInvoiceId: invoice.id, updatedAt: new Date() })
    .where(
      and(eq(commerceQuotes.id, quote.id), eq(commerceQuotes.organizationId, ctx.organizationId)),
    );
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'invoice.created',
    subject: { type: 'invoice', id: invoice.id },
    payload: {
      invoiceId: invoice.id,
      contactId: invoice.contactId,
      dealId: invoice.dealId,
      quoteId: quote.id,
    },
  });
  return getInvoice(tx, ctx, invoice.id);
}

// ── Customer view ───────────────────────────────────────────────────────────────────────

export interface PublicQuote {
  organizationId: string;
  quoteId: string;
  organization: { name: string };
  quote: {
    number: string;
    status: CommerceQuote['status'];
    /** Sent and still within its validity: the customer can accept or decline. */
    canRespond: boolean;
    issueDate: string;
    validUntil: string | null;
    currency: string;
    customer: string;
    notes: string | null;
    terms: string | null;
    footer: string | null;
    lines: LineView[];
  } & TotalsView;
}

/** System-scope lookup of a customer link: the token is what identifies the tenant. */
async function findQuoteByToken(db: Database, token: string) {
  if (!DOCUMENT_TOKEN.test(token)) return null;
  // System scope: an anonymous customer's link token is what identifies the organization.
  const [found] = await withSystem(db, (tx) =>
    tx
      .select({ id: commerceQuotes.id, organizationId: commerceQuotes.organizationId })
      .from(commerceQuotes)
      .where(eq(commerceQuotes.publicTokenHash, hashDocumentToken(token))),
  );
  return found ?? null;
}

async function organizationOf(tx: Tx, organizationId: string) {
  const [organization] = await tx
    .select({ name: organizations.name, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return { name: organization?.name ?? '', timezone: organization?.timezone ?? 'UTC' };
}

async function publicView(tx: TenantTx, quote: CommerceQuote): Promise<PublicQuote> {
  const organization = await organizationOf(tx, quote.organizationId);
  const settings = await getSettingsRow(tx, quote.organizationId);
  const party = (await partiesOf(tx, quote.organizationId, [quote])).get(partyKey(quote));
  const today = localDate(new Date(), organization.timezone);
  return {
    organizationId: quote.organizationId,
    quoteId: quote.id,
    organization: { name: organization.name },
    quote: {
      number: quote.number,
      status: quote.status,
      canRespond:
        quote.status === 'sent' && (quote.validUntil === null || quote.validUntil >= today),
      issueDate: quote.issueDate,
      validUntil: quote.validUntil,
      currency: quote.currency,
      customer: party?.company?.name ?? party?.contact?.name ?? '',
      notes: quote.notes,
      terms: quote.terms,
      footer: settings.invoiceFooter,
      lines: (await quoteLines(tx, quote)).map((line) => lineView(line, quote.currency)),
      ...totalsView(quote, quote.currency),
    },
  };
}

export async function resolvePublicQuote(db: Database, token: string): Promise<PublicQuote | null> {
  const found = await findQuoteByToken(db, token);
  if (!found) return null;
  return withTenant(db, { organizationId: found.organizationId, userId: null }, async (tx) => {
    const quote = await getQuoteRow(tx, found.organizationId, found.id);
    if (quote.status === 'draft') return null;
    return publicView(tx, quote);
  });
}

/** The customer accepts or declines through their link. */
export async function respondToPublicQuote(
  db: Database,
  token: string,
  rawInput: z.input<typeof quoteResponseSchema>,
): Promise<PublicQuote> {
  const { decision } = quoteResponseSchema.parse(rawInput);
  const found = await findQuoteByToken(db, token);
  if (!found) throw new NotFoundError('Quote');
  return withTenant(db, { organizationId: found.organizationId, userId: null }, async (tx) => {
    const quote = await getQuoteRow(tx, found.organizationId, found.id, { lock: true });
    if (quote.status === 'draft') throw new NotFoundError('Quote');
    const organization = await organizationOf(tx, quote.organizationId);
    await applyResponse(
      tx,
      quote,
      decision,
      'customer',
      { actor: { type: 'system', id: null }, correlationId: null },
      localDate(new Date(), organization.timezone),
    );
    return publicView(tx, await getQuoteRow(tx, found.organizationId, found.id));
  });
}

/** Sent quotes past their validity (in the organization's time zone) become expired. */
export async function expireQuotes(db: Database, limit = 500): Promise<{ expired: number }> {
  // System scope: maintenance runs across organizations; each change is scoped by its row.
  return withSystem(db, async (tx) => {
    const due = await tx
      .select({ id: commerceQuotes.id, organizationId: commerceQuotes.organizationId })
      .from(commerceQuotes)
      .innerJoin(organizations, eq(organizations.id, commerceQuotes.organizationId))
      .where(
        and(
          eq(commerceQuotes.status, 'sent'),
          sql`${commerceQuotes.validUntil} < (now() at time zone ${organizations.timezone})::date`,
        ),
      )
      .limit(limit)
      .for('update', { of: commerceQuotes, skipLocked: true });
    for (const quote of due) {
      await tx
        .update(commerceQuotes)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(
          and(
            eq(commerceQuotes.id, quote.id),
            eq(commerceQuotes.organizationId, quote.organizationId),
          ),
        );
    }
    return { expired: due.length };
  });
}
