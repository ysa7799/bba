import {
  createInvoice,
  issueInvoice,
  recordManualPayment,
  refundInvoicePayment,
  type CommerceServices,
} from '@businessos/commerce';
import { createContact, createDeal, defaultPipeline, type CrmContext } from '@businessos/crm';
import {
  commerceInvoices,
  commerceRefunds,
  crmContacts,
  crmDeals,
  crmTasks,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { createOrganization } from '@businessos/organizations';
import { PERMISSION_DEFINITIONS, type Permission } from '@businessos/permissions';
import { ForbiddenError, NotFoundError, ValidationError } from '@businessos/shared';
import {
  addTestMember,
  createTestDatabase,
  createTestUser,
  uniqueSuffix,
} from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  availableReports,
  bucketsFor,
  getDashboard,
  REPORT_KEYS,
  reportToCsv,
  resolveRange,
  runReport,
  type ReportContext,
  type ReportResult,
} from '../src';

let handle: DatabaseHandle;
const ALL = new Set(PERMISSION_DEFINITIONS.map((entry) => entry.key)) as ReadonlySet<Permission>;
/** "Now" for every report: 15 March 2026, 12:00 in Bahrain (UTC+3). */
const NOW = new Date('2026-03-15T09:00:00Z');
const MARCH = { from: '2026-03-01', to: '2026-03-15', granularity: 'day' as const };

beforeAll(() => {
  handle = createTestDatabase(6);
});

afterAll(async () => {
  await handle.close();
});

interface TestOrg {
  organization: Organization;
  ownerId: string;
}

async function freshOrg(): Promise<TestOrg> {
  const owner = await createTestUser(handle.db, { name: `Owner ${uniqueSuffix()}` });
  const { organization } = await createOrganization(handle.db, owner.id, {
    name: `Reports ${uniqueSuffix()}`,
    timezone: 'Asia/Bahrain',
    defaultCurrency: 'BHD',
  });
  return { organization, ownerId: owner.id };
}

function crmCtx(org: TestOrg): CrmContext {
  return {
    organizationId: org.organization.id,
    countryCode: org.organization.countryCode,
    defaultCurrency: org.organization.defaultCurrency,
    timezone: org.organization.timezone,
    actor: { type: 'user', userId: org.ownerId },
  };
}

function reportCtx(org: TestOrg, permissions: ReadonlySet<Permission> = ALL): ReportContext {
  return {
    organizationId: org.organization.id,
    userId: org.ownerId,
    timezone: org.organization.timezone,
    defaultCurrency: org.organization.defaultCurrency,
    permissions,
  };
}

function inOrg<T>(org: TestOrg, fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>): Promise<T> {
  return withTenant(handle.db, { organizationId: org.organization.id, userId: org.ownerId }, (tx) =>
    fn(tx, crmCtx(org)),
  );
}

function report(org: TestOrg, key: string, permissions?: ReadonlySet<Permission>) {
  return inOrg(org, (tx) => runReport(tx, reportCtx(org, permissions), key, MARCH, NOW));
}

function metric(result: ReportResult, key: string, currency: string | null = null) {
  return result.metrics.find((entry) => entry.key === key && entry.currency === currency)?.value;
}

function point(
  result: ReportResult,
  seriesKey: string,
  bucket: string,
  currency: string | null = null,
) {
  return result.series
    .find((entry) => entry.key === seriesKey && entry.currency === currency)
    ?.points.find((entry) => entry.bucket === bucket)?.value;
}

async function contactAt(org: TestOrg, createdAt: string, overrides: Record<string, string> = {}) {
  const contact = await inOrg(org, (tx, ctx) =>
    createContact(tx, ctx, {
      firstName: 'Noor',
      lastName: `Abbas ${uniqueSuffix()}`,
      ...overrides,
    }),
  );
  await withSystem(handle.db, (tx) =>
    tx
      .update(crmContacts)
      .set({ createdAt: new Date(createdAt) })
      .where(eq(crmContacts.id, contact.id)),
  );
  return contact;
}

describe('periods', () => {
  it('resolves days in the organization time zone and validates bounds', async () => {
    const org = await freshOrg();
    const range = await inOrg(org, (tx) => resolveRange(tx, 'Asia/Bahrain', MARCH, NOW));
    // Midnight in Bahrain is 21:00 UTC the day before.
    expect(range.start.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-03-15T21:00:00.000Z');
    expect(range.buckets).toHaveLength(15);
    const defaults = await inOrg(org, (tx) => resolveRange(tx, 'Asia/Bahrain', {}, NOW));
    expect(defaults).toMatchObject({ from: '2026-02-14', to: '2026-03-15', granularity: 'day' });
    await expect(
      inOrg(org, (tx) =>
        resolveRange(tx, 'Asia/Bahrain', { from: '2026-03-02', to: '2026-03-01' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inOrg(org, (tx) =>
        resolveRange(tx, 'Asia/Bahrain', { from: '2025-01-01', to: '2026-03-01' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inOrg(org, (tx) =>
        resolveRange(tx, 'Asia/Bahrain', { granularity: 'hour' as unknown as 'day' }),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('builds Monday weeks and calendar months', () => {
    expect(bucketsFor('2026-03-04', '2026-03-17', 'week')).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
    ]);
    expect(bucketsFor('2025-12-15', '2026-02-01', 'month')).toEqual([
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
  });
});

describe('contacts report', () => {
  it('counts each record in the local day it happened, never another tenant’s', async () => {
    const org = await freshOrg();
    const other = await freshOrg();
    await contactAt(org, '2026-02-28T20:59:00Z'); // 28 Feb 23:59 local: before the period
    await contactAt(org, '2026-02-28T21:30:00Z'); // 1 Mar 00:30 local
    await contactAt(org, '2026-03-01T20:30:00Z'); // 1 Mar 23:30 local
    await contactAt(org, '2026-03-01T21:30:00Z', { source: 'import' }); // 2 Mar 00:30 local
    await contactAt(other, '2026-03-01T10:00:00Z');
    const result = await report(org, 'contacts');
    expect(metric(result, 'new_contacts')).toBe('3');
    expect(metric(result, 'contacts')).toBe('4');
    expect(point(result, 'new_contacts', '2026-03-01')).toBe('2');
    expect(point(result, 'new_contacts', '2026-03-02')).toBe('1');
    expect(point(result, 'new_contacts', '2026-03-03')).toBe('0');
    const series = result.series[0];
    expect(series?.points.find((entry) => entry.bucket === '2026-03-01')?.scale).toBe(1000);
    expect(series?.points.find((entry) => entry.bucket === '2026-03-02')?.scale).toBe(500);
    expect(result.tables.find((table) => table.key === 'new_by_source')?.rows).toEqual(
      expect.arrayContaining([
        ['manual', '2'],
        ['import', '1'],
      ]),
    );
  });
});

describe('sales pipeline report', () => {
  it('keeps currencies apart and weights open deals by probability', async () => {
    const org = await freshOrg();
    const other = await freshOrg();
    const pipeline = await inOrg(org, (tx) => defaultPipeline(tx, org.organization.id));
    const lead = pipeline.stages.find((stage) => stage.name === 'Lead');
    await inOrg(org, async (tx, ctx) => {
      await createDeal(tx, ctx, {
        name: 'Gym fit-out',
        stageId: lead?.id,
        value: { amount: '1000.000', currency: 'BHD' },
      });
      await createDeal(tx, ctx, {
        name: 'Riyadh branch',
        value: { amount: '500.00', currency: 'SAR' },
        probability: 50,
      });
      const won = await createDeal(tx, ctx, {
        name: 'Annual membership',
        value: { amount: '250.500', currency: 'BHD' },
      });
      const lost = await createDeal(tx, ctx, {
        name: 'Corporate plan',
        value: { amount: '90.000', currency: 'BHD' },
      });
      return { won, lost };
    }).then(async ({ won, lost }) => {
      await withSystem(handle.db, async (tx) => {
        await tx
          .update(crmDeals)
          .set({ status: 'won', closedAt: new Date('2026-03-10T10:00:00Z') })
          .where(eq(crmDeals.id, won.id));
        await tx
          .update(crmDeals)
          .set({ status: 'lost', closedAt: new Date('2026-03-11T10:00:00Z') })
          .where(eq(crmDeals.id, lost.id));
      });
    });
    await inOrg(other, (tx, ctx) =>
      createDeal(tx, ctx, { name: 'Elsewhere', value: { amount: '99999.000', currency: 'BHD' } }),
    );
    const result = await report(org, 'sales_pipeline');
    expect(metric(result, 'open_deals')).toBe('2');
    expect(metric(result, 'open_value', 'BHD')).toBe('1000.000');
    expect(metric(result, 'open_value', 'SAR')).toBe('500.00');
    // 10 % (Lead) of BHD 1000.000 and 50 % (deal override) of SAR 500.00.
    expect(metric(result, 'weighted_value', 'BHD')).toBe('100.000');
    expect(metric(result, 'weighted_value', 'SAR')).toBe('250.00');
    expect(metric(result, 'won_value', 'BHD')).toBe('250.500');
    expect(metric(result, 'win_rate')).toBe('50.0');
    expect(point(result, 'deals_won', '2026-03-10')).toBe('1');
    const byStage = result.tables.find((table) => table.key === 'open_by_stage');
    expect(byStage?.rows).toEqual(
      expect.arrayContaining([[pipeline.name, 'Lead', '1', 'BHD', '1000.000']]),
    );
  });
});

describe('revenue report', () => {
  it('reports invoiced, collected, refunded and outstanding money exactly per currency', async () => {
    const org = await freshOrg();
    const customer = await contactAt(org, '2026-01-10T10:00:00Z', { firstName: 'Salman' });
    const invoice = await inOrg(org, async (tx, ctx) => {
      const draft = await createInvoice(tx, ctx, {
        contactId: customer.id,
        currency: 'BHD',
        lines: [{ description: 'Consulting', quantity: '1', unitAmount: '100.000' }],
      });
      return (await issueInvoice(tx, ctx, draft.id)).invoice;
    });
    await withSystem(handle.db, (tx) =>
      tx
        .update(commerceInvoices)
        .set({ issueDate: '2026-03-05', dueDate: '2026-03-10' })
        .where(eq(commerceInvoices.id, invoice.id)),
    );
    const paid = await inOrg(org, (tx, ctx) =>
      recordManualPayment(tx, ctx, invoice.id, {
        amount: '60.000',
        method: 'cash',
        receivedAt: '2026-03-06T10:00:00Z',
      }),
    );
    const services: CommerceServices = {
      db: handle.db,
      providers: new Map(),
      secretBox: null,
      apiPublicUrl: 'http://localhost:4000',
      appUrl: 'http://localhost:3000',
    };
    const audit = {
      actorType: 'user' as const,
      actorUserId: org.ownerId,
      actorLabel: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
    };
    await refundInvoicePayment(services, crmCtx(org), audit, invoice.id, paid.paymentId, {
      amount: '10.000',
      reason: 'Goodwill',
    });
    await withSystem(handle.db, (tx) =>
      tx
        .update(commerceRefunds)
        .set({ createdAt: new Date('2026-03-07T10:00:00Z') })
        .where(eq(commerceRefunds.invoiceId, invoice.id)),
    );

    const result = await report(org, 'revenue');
    expect(metric(result, 'invoices_issued')).toBe('1');
    expect(metric(result, 'invoiced', 'BHD')).toBe('100.000');
    expect(metric(result, 'collected', 'BHD')).toBe('60.000');
    expect(metric(result, 'refunded', 'BHD')).toBe('10.000');
    expect(metric(result, 'net_collected', 'BHD')).toBe('50.000');
    expect(metric(result, 'outstanding', 'BHD')).toBe('50.000');
    expect(metric(result, 'overdue', 'BHD')).toBe('50.000');
    expect(metric(result, 'overdue_invoices')).toBe('1');
    expect(point(result, 'invoiced', '2026-03-05', 'BHD')).toBe('100.000');
    expect(point(result, 'collected', '2026-03-06', 'BHD')).toBe('60.000');
    const top = result.tables.find((table) => table.key === 'top_customers');
    expect(top?.rows[0]).toEqual([
      expect.stringContaining('Salman'),
      null,
      'BHD',
      '100.000',
      '50.000',
    ]);

    // Without contact access the money is still reported, the customer's name is not.
    const limited = new Set([...ALL].filter((key) => key !== 'crm.contact.read'));
    const withheld = await report(org, 'revenue', limited);
    expect(withheld.tables.find((table) => table.key === 'top_customers')?.rows[0]?.[0]).toBeNull();
    expect(metric(withheld, 'invoiced', 'BHD')).toBe('100.000');
  });
});

describe('permissions', () => {
  it('only offers and runs reports over data the person may read', async () => {
    const org = await freshOrg();
    const salesOnly = new Set<Permission>(['reports.read', 'crm.deal.read', 'crm.contact.read']);
    expect(availableReports(reportCtx(org, salesOnly))).toEqual(['sales_pipeline', 'contacts']);
    expect(availableReports(reportCtx(org, new Set<Permission>(['crm.deal.read'])))).toEqual([]);
    await expect(report(org, 'revenue', salesOnly)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      report(org, 'sales_pipeline', new Set<Permission>(['crm.deal.read'])),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(report(org, 'payroll')).rejects.toBeInstanceOf(NotFoundError);

    const dashboard = await inOrg(org, (tx) => getDashboard(tx, reportCtx(org, salesOnly), NOW));
    expect(dashboard.widgets.map((widget) => widget.report)).toEqual([
      'sales_pipeline',
      'contacts',
    ]);
    expect(dashboard.range).toMatchObject({ from: '2026-03-01', to: '2026-03-15' });
    const none = await inOrg(org, (tx) =>
      getDashboard(tx, reportCtx(org, new Set<Permission>(['crm.deal.read'])), NOW),
    );
    expect(none.widgets).toEqual([]);
  });

  it('every report runs on an empty organization with complete, zeroed series', async () => {
    const org = await freshOrg();
    for (const key of REPORT_KEYS) {
      const result = await report(org, key);
      expect(result.range).toMatchObject({ from: '2026-03-01', to: '2026-03-15' });
      for (const entry of result.series) {
        expect(entry.points).toHaveLength(15);
        expect(['0', '0.000']).toContain(entry.total);
      }
    }
    // Money with no activity is zero in the organization's currency (BHD has 3 decimals).
    const empty = await report(org, 'revenue');
    expect(metric(empty, 'invoiced', 'BHD')).toBe('0.000');
    expect(empty.series.map((entry) => `${entry.key}:${entry.currency ?? ''}`)).toEqual([
      'invoiced:BHD',
      'collected:BHD',
    ]);
  });
});

describe('CSV', () => {
  it('neutralizes spreadsheet formulas in names', async () => {
    const org = await freshOrg();
    // A member whose display name is a spreadsheet formula.
    const attacker = await createTestUser(handle.db, { name: '=HYPERLINK("http://evil")' });
    await addTestMember(handle.db, org.organization.id, attacker.id);
    await withSystem(handle.db, (tx) =>
      tx.insert(crmTasks).values({
        organizationId: org.organization.id,
        title: 'Follow up',
        assigneeUserId: attacker.id,
        dueAt: new Date('2026-03-01T10:00:00Z'),
      }),
    );
    const result = await report(org, 'tasks');
    expect(metric(result, 'open_tasks')).toBe('1');
    expect(metric(result, 'overdue_tasks')).toBe('1');
    const csv = reportToCsv(result);
    expect(csv.startsWith('﻿report,tasks')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")",1,1`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
