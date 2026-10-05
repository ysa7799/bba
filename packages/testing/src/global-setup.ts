import { runMigrations } from '@businessos/database/migrate';
import { loadTestEnv, requireEnv } from '@businessos/database/testing';

/** Vitest global setup: apply migrations to the test database once per run. */
export default async function setup(): Promise<void> {
  loadTestEnv();
  await runMigrations(requireEnv('MIGRATION_DATABASE_URL'));
}
