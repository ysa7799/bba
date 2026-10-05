import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Outside test-results/, which Playwright clears after global setup.
export const E2E_STATE_FILE = path.resolve(import.meta.dirname, '../.e2e-state.json');

/**
 * Seeds a public paid plan with a unique name for the subscription flow. Runs with the owner
 * connection in system scope (the catalogue is not writable from tenant scope).
 */
export default async function globalSetup(): Promise<void> {
  const client = new pg.Client({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ??
      'postgres://businessos:businessos@localhost:5432/businessos_test',
  });
  await client.connect();
  const planName = `E2E Pro ${Date.now()}`;
  const planId = randomUUID();
  const versionId = randomUUID();
  try {
    await client.query('begin');
    await client.query("select set_config('app.system', 'on', true)");
    await client.query(
      `insert into plans (id, key, name, description, status, is_public, is_default, sort_order)
       values ($1, $2, $3, 'Paid plan for end-to-end tests', 'active', true, false, -5000)`,
      [planId, `e2e-${Date.now()}`, planName],
    );
    await client.query(
      `insert into plan_versions (id, plan_id, version, status, published_at)
       values ($1, $2, 1, 'published', now())`,
      [versionId, planId],
    );
    await client.query(
      `insert into plan_entitlements (plan_version_id, key, value)
       values ($1, 'users.max', '{"value": 25}'), ($1, 'projects.enabled', '{"value": true}'),
              ($1, 'automation.workflows.max', '{"value": 10}'),
              ($1, 'automation.monthly_executions', '{"value": 1000}')`,
      [versionId],
    );
    await client.query(
      `insert into prices (id, plan_version_id, currency, interval, amount_minor)
       values ($1, $2, 'BHD', 'month', 19500)`,
      [randomUUID(), versionId],
    );
    await client.query('commit');
  } finally {
    await client.end();
  }
  writeFileSync(E2E_STATE_FILE, JSON.stringify({ planName }));
}
