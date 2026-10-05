import { eventMeta, type CrmContext } from '@businessos/crm';
import {
  commerceCheckouts,
  commerceInvoiceItems,
  commerceInvoicePayments,
  commerceInvoices,
  commerceRefunds,
  organizations,
  payments,
  withSystem,
  withTenant,
  type CommerceInvoice,
  type Database,
  type TenantTx,
  type Tx,
} from '@businessos/database';
import { emitEvent, type EventActor } from '@businessos/events';
import {
  ConflictError,
  decodeCursor,
  encodeCursor,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { createHash, randomBytes } from 'node:crypto';
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
import { moneyView, type MoneyView } from './money';

/** Who caused a change, for events emitted outside a request context. */
export interface EventMeta {
  actor: EventActor;
  correlationId: string | null;
}

export function hashDocumentToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** A new customer link token (256 bits); only its hash is stored. */
export function newDocumentToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashDocumentToken(token) };
}

export const DOCUMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDaysToDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

export const createInvoiceInputSchema = z.object({
  ...documentFields,
  dueDate: z.iso.date().nullable().optional(),
});
export const updateInvoiceInputSchema = createInvoiceInputSchema.partial();
export const invoiceListQuerySchema = z.object({
  status: z.enum(['draft', 'open', 'paid', 'void', 'overdue']).optional(),
  contactId: z.uuid().optional(),
  dealId: z.uuid().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface InvoiceSummary extends PartyView, TotalsView {
  id: string;
  number: string | null;
  status: CommerceInvoice['status'];
  overdue: boolean;
  currency: string;
  dealId: string | null;
  quoteId: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amountPaid: MoneyView;
  amountDue: MoneyView;
  /** Received beyond the total (e.g. paid twice online); staff refund it. */
  amountOverpaid: MoneyView;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  notes: string | null;
  terms: string | null;
  lines: LineView[];
  payments: {
    id: string;
    source: 'online' | 'manual';
    method: string;
    amount: MoneyView;
    refunded: MoneyView;
    /** What can still be refunded from this payment. */
    refundable: MoneyView;
    reference: string | null;
    note: string | null;
    receivedAt: string;
  }[];
  refunds: {
    id: string;
    invoicePaymentId: string;
    amount: MoneyView;
    reason: string;
    status: string;
    createdAt: string;
  }[];
  attempts: { paymentId: string; status: string; amount: MoneyView; createdAt: string }[];
}

export function amountDueMinor(
  invoice: Pick<CommerceInvoice, 'totalMinor' | 'amountPaidMinor' | 'status'>,
): bigint {
  if (invoice.status !== 'open') return 0n;
  const due = invoice.totalMinor - invoice.amountPaidMinor;
  return due > 0n ? due : 0n;
}

export function overpaidMinor(
  invoice: Pick<CommerceInvoice, 'totalMinor' | 'amountPaidMinor' | 'status'>,
): bigint {
  if (invoice.status === 'draft') return 0n;
  const limit = invoice.status === 'void' ? 0n : invoice.totalMinor;
  return invoice.amountPaidMinor > limit ? invoice.amountPaidMinor - limit : 0n;
}

function isOverdue(invoice: CommerceInvoice, today: string): boolean {
  return invoice.status === 'open' && invoice.dueDate !== null && invoice.dueDate < today;
}

async function organizationTimezone(tx: Tx, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.timezone ?? 'UTC';
}

async function summaries(
  tx: TenantTx,
  ctx: CrmContext,
  rows: CommerceInvoice[],
): Promise<InvoiceSummary[]> {
  const parties = await partiesOf(tx, ctx.organizationId, rows, ctx.canRead?.contact ?? true);
  const today = localDate(new Date(), ctx.timezone);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    overdue: isOverdue(row, today),
    currency: row.currency,
    ...(parties.get(partyKey(row)) ?? { contact: null, company: null }),
    dealId: row.dealId,
    quoteId: row.quoteId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    ...totalsView(row, row.currency),
    amountPaid: moneyView(row.amountPaidMinor, row.currency),
    amountDue: moneyView(amountDueMinor(row), row.currency),
    amountOverpaid: moneyView(overpaidMinor(row), row.currency),
    sentAt: row.sentAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getInvoiceRow(
  tx: Tx,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<CommerceInvoice> {
  const query = tx
    .select()
    .from(commerceInvoices)
    .where(and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, organizationId)));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Invoice');
  return row;
}

async function linesOf(
  tx: Tx,
  organizationId: string,
  invoice: CommerceInvoice,
): Promise<LineView[]> {
  const rows = await tx
    .select()
    .from(commerceInvoiceItems)
    .where(
      and(
        eq(commerceInvoiceItems.invoiceId, invoice.id),
        eq(commerceInvoiceItems.organizationId, organizationId),
      ),
    )
    .orderBy(asc(commerceInvoiceItems.position));
  return rows.map((row) => lineView(row, invoice.currency));
}

export async function getInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<InvoiceDetail> {
  const row = await getInvoiceRow(tx, ctx.organizationId, id);
  const [summary] = await summaries(tx, ctx, [row]);
  if (!summary) throw new NotFoundError('Invoice');
  const applied = await tx
    .select()
    .from(commerceInvoicePayments)
    .where(
      and(
        eq(commerceInvoicePayments.invoiceId, id),
        eq(commerceInvoicePayments.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(commerceInvoicePayments.receivedAt));
  const refunds = await tx
    .select()
    .from(commerceRefunds)
    .where(
      and(
        eq(commerceRefunds.invoiceId, id),
        eq(commerceRefunds.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(asc(commerceRefunds.createdAt));
  const attempts = await tx
    .select({ payment: payments, createdAt: commerceCheckouts.createdAt })
    .from(commerceCheckouts)
    .innerJoin(payments, eq(payments.id, commerceCheckouts.paymentId))
    .where(
      and(
        eq(commerceCheckouts.invoiceId, id),
        eq(commerceCheckouts.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(desc(commerceCheckouts.createdAt))
    .limit(50);
  return {
    ...summary,
    notes: row.notes,
    terms: row.terms,
    lines: await linesOf(tx, ctx.organizationId, row),
    payments: applied.map((entry) => ({
      id: entry.id,
      source: entry.source,
      method: entry.method,
      amount: moneyView(entry.amountMinor, entry.currency),
      refunded: moneyView(entry.refundedMinor, entry.currency),
      refundable: moneyView(entry.amountMinor - entry.refundedMinor, entry.currency),
      reference: entry.reference,
      note: entry.note,
      receivedAt: entry.receivedAt.toISOString(),
    })),
    refunds: refunds.map((refund) => ({
      id: refund.id,
      invoicePaymentId: refund.invoicePaymentId,
      amount: moneyView(refund.amountMinor, refund.currency),
      reason: refund.reason,
      status: refund.status,
      createdAt: refund.createdAt.toISOString(),
    })),
    attempts: attempts.map((entry) => ({
      paymentId: entry.payment.id,
      status: entry.payment.status,
      amount: moneyView(entry.payment.amountMinor, entry.payment.currency),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export async function listInvoices(
  tx: TenantTx,
  ctx: CrmContext,
  rawQuery: z.input<typeof invoiceListQuerySchema>,
): Promise<{ data: InvoiceSummary[]; nextCursor: string | null }> {
  const query = invoiceListQuerySchema.parse(rawQuery);
  const conditions: SQL[] = [eq(commerceInvoices.organizationId, ctx.organizationId)];
  if (query.status === 'overdue') {
    conditions.push(
      eq(commerceInvoices.status, 'open'),
      sql`${commerceInvoices.dueDate} < ${localDate(new Date(), ctx.timezone)}::date`,
    );
  } else if (query.status) {
    conditions.push(eq(commerceInvoices.status, query.status));
  }
  if (query.contactId) conditions.push(eq(commerceInvoices.contactId, query.contactId));
  if (query.dealId) conditions.push(eq(commerceInvoices.dealId, query.dealId));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, z.object({ v: z.string().max(40), id: z.uuid() }));
    conditions.push(
      sql`(${commerceInvoices.createdAt}, ${commerceInvoices.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({ row: commerceInvoices, sortValue: sql<string>`${commerceInvoices.createdAt}::text` })
    .from(commerceInvoices)
    .where(and(...conditions))
    .orderBy(desc(commerceInvoices.createdAt), desc(commerceInvoices.id))
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

async function writeLines(
  tx: TenantTx,
  organizationId: string,
  invoiceId: string,
  lines: Awaited<ReturnType<typeof buildLines>>['lines'],
): Promise<void> {
  await tx
    .delete(commerceInvoiceItems)
    .where(
      and(
        eq(commerceInvoiceItems.invoiceId, invoiceId),
        eq(commerceInvoiceItems.organizationId, organizationId),
      ),
    );
  await tx
    .insert(commerceInvoiceItems)
    .values(lines.map((line) => ({ ...lineValues(organizationId, line), invoiceId })));
}

/** Creates a draft invoice; amounts are computed from the lines on the server. */
export async function createInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createInvoiceInputSchema>,
  options: { quoteId?: string } = {},
): Promise<InvoiceDetail> {
  const input = createInvoiceInputSchema.parse(rawInput);
  const currency = input.currency ?? ctx.defaultCurrency;
  await assertParties(tx, ctx.organizationId, input);
  const { lines, totals } = await buildLines(tx, ctx.organizationId, currency, input.lines);
  const [row] = await tx
    .insert(commerceInvoices)
    .values({
      organizationId: ctx.organizationId,
      contactId: input.contactId,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      quoteId: options.quoteId ?? null,
      currency,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      dueDate: input.dueDate ?? null,
      ...totals,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!row) throw new Error('invoice insert returned no row');
  await writeLines(tx, ctx.organizationId, row.id, lines);
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'invoice.created',
    subject: { type: 'invoice', id: row.id },
    payload: {
      invoiceId: row.id,
      contactId: row.contactId,
      dealId: row.dealId,
      quoteId: row.quoteId,
    },
  });
  return getInvoice(tx, ctx, row.id);
}

/** Only drafts can be edited: an issued invoice is a legal document. */
export async function updateInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateInvoiceInputSchema>,
): Promise<InvoiceDetail> {
  const input = updateInvoiceInputSchema.parse(rawInput);
  const current = await getInvoiceRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft') throw new ConflictError('Only draft invoices can be edited');
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
    await writeLines(tx, ctx.organizationId, id, built.lines);
    totals = built.totals;
  }
  await tx
    .update(commerceInvoices)
    .set({
      ...merged,
      currency,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.terms !== undefined ? { terms: input.terms } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...totals,
      updatedAt: new Date(),
    })
    .where(
      and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, ctx.organizationId)),
    );
  return getInvoice(tx, ctx, id);
}

export async function deleteDraftInvoice(tx: TenantTx, ctx: CrmContext, id: string): Promise<void> {
  const current = await getInvoiceRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft')
    throw new ConflictError('Only drafts can be deleted; void the invoice instead');
  await tx
    .delete(commerceInvoices)
    .where(
      and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, ctx.organizationId)),
    );
}

/**
 * Issues a draft: assigns the next number (gapless), sets the issue and due dates and creates
 * the customer link. Returns the link token (only its hash is stored).
 */
export async function issueInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ invoice: InvoiceDetail; token: string }> {
  const current = await getInvoiceRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'draft') throw new ConflictError('This invoice has already been issued');
  if (current.totalMinor <= 0n) {
    throw new ValidationError('An invoice needs a total above zero', [
      { path: 'lines', message: 'Total is zero' },
    ]);
  }
  const settings = await getSettingsRow(tx, ctx.organizationId);
  const issueDate = localDate(new Date(), ctx.timezone);
  const dueDate =
    current.dueDate && current.dueDate >= issueDate
      ? current.dueDate
      : addDaysToDate(issueDate, settings.defaultDueDays);
  const number = await allocateNumber(tx, ctx.organizationId, 'invoice');
  const { token, hash } = newDocumentToken();
  const now = new Date();
  await tx
    .update(commerceInvoices)
    .set({
      status: 'open',
      number,
      issueDate,
      dueDate,
      publicTokenHash: hash,
      sentAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, ctx.organizationId)),
    );
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'invoice.sent',
    subject: { type: 'invoice', id },
    payload: {
      invoiceId: id,
      contactId: current.contactId,
      totalMinor: current.totalMinor.toString(),
      currency: current.currency,
    },
  });
  return { invoice: await getInvoice(tx, ctx, id), token };
}

/** A new customer link for an issued invoice (the previous link stops working). */
export async function renewInvoiceLink(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ invoice: InvoiceDetail; token: string }> {
  const current = await getInvoiceRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status === 'draft' || current.status === 'void') {
    throw new ConflictError('Only issued invoices can be sent');
  }
  const { token, hash } = newDocumentToken();
  await tx
    .update(commerceInvoices)
    .set({ publicTokenHash: hash, sentAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, ctx.organizationId)),
    );
  return { invoice: await getInvoice(tx, ctx, id), token };
}

/** Voids an issued invoice that has no payments (refund them first). Its number stays used. */
export async function voidInvoice(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<InvoiceDetail> {
  const current = await getInvoiceRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'open') throw new ConflictError('Only open invoices can be voided');
  if (current.amountPaidMinor > 0n) {
    throw new ConflictError('Refund the payments before voiding this invoice');
  }
  await tx
    .update(commerceInvoices)
    .set({ status: 'void', voidedAt: new Date(), publicTokenHash: null, updatedAt: new Date() })
    .where(
      and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, ctx.organizationId)),
    );
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'invoice.voided',
    subject: { type: 'invoice', id },
    payload: { invoiceId: id, contactId: current.contactId },
  });
  return getInvoice(tx, ctx, id);
}

/**
 * Recomputes what was paid from the applied payments and refunds and moves the invoice between
 * open and paid. Emits `invoice.paid` on the transition into paid. Caller holds the invoice
 * row lock.
 */
export async function settleInvoice(
  tx: Tx,
  invoice: CommerceInvoice,
  meta: EventMeta,
): Promise<CommerceInvoice> {
  const [sums] = await tx
    .select({
      paid: sql<string>`coalesce(sum(${commerceInvoicePayments.amountMinor}), 0)::text`,
      refunded: sql<string>`coalesce(sum(${commerceInvoicePayments.refundedMinor}), 0)::text`,
    })
    .from(commerceInvoicePayments)
    .where(
      and(
        eq(commerceInvoicePayments.invoiceId, invoice.id),
        eq(commerceInvoicePayments.organizationId, invoice.organizationId),
      ),
    );
  const paid = BigInt(sums?.paid ?? '0');
  const refunded = BigInt(sums?.refunded ?? '0');
  const net = paid - refunded;
  const nowPaid =
    invoice.status !== 'void' && invoice.status !== 'draft' && net >= invoice.totalMinor;
  const status =
    invoice.status === 'void' || invoice.status === 'draft'
      ? invoice.status
      : nowPaid
        ? 'paid'
        : 'open';
  const becamePaid = status === 'paid' && invoice.status !== 'paid';
  const [updated] = await tx
    .update(commerceInvoices)
    .set({
      amountPaidMinor: net,
      amountRefundedMinor: refunded,
      status,
      paidAt: status === 'paid' ? (invoice.paidAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commerceInvoices.id, invoice.id),
        eq(commerceInvoices.organizationId, invoice.organizationId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Invoice');
  if (becamePaid) {
    await emitEvent(tx, {
      organizationId: invoice.organizationId,
      actor: meta.actor,
      correlationId: meta.correlationId,
      type: 'invoice.paid',
      subject: { type: 'invoice', id: invoice.id },
      payload: {
        invoiceId: invoice.id,
        contactId: invoice.contactId,
        totalMinor: invoice.totalMinor.toString(),
        currency: invoice.currency,
      },
    });
  }
  return updated;
}

// ── Customer view ───────────────────────────────────────────────────────────────────────

export interface PublicInvoice {
  organizationId: string;
  invoiceId: string;
  organization: { name: string };
  invoice: {
    number: string;
    status: CommerceInvoice['status'];
    overdue: boolean;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    customer: string;
    notes: string | null;
    terms: string | null;
    footer: string | null;
    lines: LineView[];
    amountPaid: MoneyView;
    amountDue: MoneyView;
  } & TotalsView;
}

/** Resolves a customer link (system-scope lookup by token hash, then tenant scope). */
export async function resolvePublicInvoice(
  db: Database,
  token: string,
): Promise<PublicInvoice | null> {
  if (!DOCUMENT_TOKEN.test(token)) return null;
  // System scope: the anonymous customer's link token is what identifies the tenant.
  const [found] = await withSystem(db, (tx) =>
    tx
      .select({ id: commerceInvoices.id, organizationId: commerceInvoices.organizationId })
      .from(commerceInvoices)
      .where(eq(commerceInvoices.publicTokenHash, hashDocumentToken(token))),
  );
  if (!found) return null;
  return withTenant(db, { organizationId: found.organizationId, userId: null }, async (tx) => {
    const invoice = await getInvoiceRow(tx, found.organizationId, found.id);
    if (
      invoice.status === 'draft' ||
      invoice.status === 'void' ||
      !invoice.number ||
      !invoice.issueDate
    ) {
      return null;
    }
    const [organization] = await tx
      .select({ name: organizations.name, timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, found.organizationId));
    const settings = await getSettingsRow(tx, found.organizationId);
    const parties = await partiesOf(tx, found.organizationId, [invoice]);
    const party = parties.get(partyKey(invoice));
    const timezone =
      organization?.timezone ?? (await organizationTimezone(tx, found.organizationId));
    return {
      organizationId: found.organizationId,
      invoiceId: invoice.id,
      organization: { name: organization?.name ?? '' },
      invoice: {
        number: invoice.number,
        status: invoice.status,
        overdue: isOverdue(invoice, localDate(new Date(), timezone)),
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        customer: party?.company?.name ?? party?.contact?.name ?? '',
        notes: invoice.notes,
        terms: invoice.terms,
        footer: settings.invoiceFooter,
        lines: await linesOf(tx, found.organizationId, invoice),
        ...totalsView(invoice, invoice.currency),
        amountPaid: moneyView(invoice.amountPaidMinor, invoice.currency),
        amountDue: moneyView(amountDueMinor(invoice), invoice.currency),
      },
    };
  });
}

/**
 * Marks open invoices past their due date (in each organization's time zone) as overdue, once
 * each, emitting `invoice.overdue` for notifications and workflows.
 */
export async function markOverdueInvoices(db: Database, limit = 500): Promise<{ overdue: number }> {
  // System scope: maintenance runs across organizations; each change is scoped by its row.
  return withSystem(db, async (tx) => {
    const due = await tx
      .select({ invoice: commerceInvoices })
      .from(commerceInvoices)
      .innerJoin(organizations, eq(organizations.id, commerceInvoices.organizationId))
      .where(
        and(
          eq(commerceInvoices.status, 'open'),
          sql`${commerceInvoices.overdueAt} is null`,
          sql`${commerceInvoices.dueDate} < (now() at time zone ${organizations.timezone})::date`,
        ),
      )
      .limit(limit)
      .for('update', { of: commerceInvoices, skipLocked: true });
    for (const { invoice } of due) {
      await tx
        .update(commerceInvoices)
        .set({ overdueAt: new Date() })
        .where(
          and(
            eq(commerceInvoices.id, invoice.id),
            eq(commerceInvoices.organizationId, invoice.organizationId),
          ),
        );
      await emitEvent(tx, {
        organizationId: invoice.organizationId,
        actor: { type: 'system', id: null },
        type: 'invoice.overdue',
        subject: { type: 'invoice', id: invoice.id },
        payload: {
          invoiceId: invoice.id,
          contactId: invoice.contactId,
          dueDate: invoice.dueDate ?? '',
        },
      });
    }
    return { overdue: due.length };
  });
}
