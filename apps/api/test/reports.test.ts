import { auditLogs, withSystem } from '@businessos/database';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

const reports = (orgId: string, path = '') => `/app/orgs/${orgId}/reports${path}`;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

describe('reports API', () => {
  it('offers each role only the reports over data it may read', async () => {
    const owner = await as(world.orgA.users.owner);
    const sales = await as(world.orgA.users.sales);
    const restricted = await as(world.orgA.users.restricted);
    expect((await owner.get(reports(A))).json().reports).toEqual([
      'sales_pipeline',
      'revenue',
      'contacts',
      'tasks',
      'conversations',
      'appointments',
      'forms',
      'automation',
    ]);
    // Members cannot read workflows, so no automation report or dashboard widget.
    expect((await sales.get(reports(A))).json().reports).not.toContain('automation');
    expect((await sales.get(reports(A, '/automation'))).statusCode).toBe(403);
    const dashboard = await sales.get(reports(A, '/dashboard'));
    expect(dashboard.statusCode).toBe(200);
    expect(
      dashboard.json().widgets.map((widget: { report: string }) => widget.report),
    ).not.toContain('automation');
    // Restricted members have no `reports.read`.
    expect((await restricted.get(reports(A))).json().reports).toEqual([]);
    expect((await restricted.get(reports(A, '/dashboard'))).statusCode).toBe(403);
    expect((await restricted.get(reports(A, '/contacts'))).statusCode).toBe(403);
  });

  it('counts this organization only and validates the period', async () => {
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(`/app/orgs/${A}/crm/contacts`, {
      firstName: 'Reem',
      lastName: `Jaber ${uniqueSuffix()}`,
    });
    expect(created.statusCode).toBe(201);
    const mine = (await owner.get(reports(A, '/contacts'))).json().report;
    const newContacts = (report: { metrics: { key: string; value: string }[] }) =>
      Number(report.metrics.find((entry) => entry.key === 'new_contacts')?.value);
    expect(newContacts(mine)).toBeGreaterThanOrEqual(1);
    const bOwner = await as(world.orgB.users.owner);
    const theirs = (await bOwner.get(reports(B, '/contacts'))).json().report;
    expect(newContacts(theirs)).toBe(0);
    expect(mine.range.timezone).toBe(world.orgA.organization.timezone);

    expect((await bOwner.get(reports(A, '/contacts'))).statusCode).toBe(404);
    expect((await owner.get(reports(A, '/payroll'))).statusCode).toBe(404);
    expect(
      (await owner.get(reports(A, '/contacts?from=2026-03-02&to=2026-03-01'))).statusCode,
    ).toBe(400);
    expect(
      (await owner.get(reports(A, '/contacts?from=2024-01-01&to=2026-03-01'))).statusCode,
    ).toBe(400);
    expect((await owner.get(reports(A, '/contacts?granularity=hour'))).statusCode).toBe(400);
    const weekly = await owner.get(
      reports(A, '/contacts?from=2026-03-01&to=2026-03-31&granularity=week'),
    );
    expect(weekly.json().report.series[0].points[0].bucket).toBe('2026-02-23');
  });

  it('downloads a report as CSV and records the export', async () => {
    const owner = await as(world.orgA.users.owner);
    const response = await owner.get(
      reports(A, '/sales_pipeline/export.csv?from=2026-03-01&to=2026-03-15'),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="sales_pipeline-2026-03-01-2026-03-15.csv"',
    );
    expect(response.body.startsWith('﻿report,sales_pipeline')).toBe(true);
    const [entry] = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.action, 'reports.exported'))),
    );
    expect(entry?.targetId).toBe('sales_pipeline');
    const sales = await as(world.orgA.users.sales);
    expect((await sales.get(reports(A, '/automation/export.csv'))).statusCode).toBe(403);
  });
});
