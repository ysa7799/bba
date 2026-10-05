import { runMigrations } from '../src/migrate';
import { loadTestEnv, requireEnv } from '../src/testing';

export default async function setup(): Promise<void> {
  loadTestEnv();
  await runMigrations(requireEnv('MIGRATION_DATABASE_URL'));
}
