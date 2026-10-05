import { runMigrations } from '@businessos/database/migrate';
import { loadTestEnv, requireEnv } from '@businessos/database/testing';

export default async function setup(): Promise<void> {
  loadTestEnv();
  await runMigrations(requireEnv('MIGRATION_DATABASE_URL'));
}
