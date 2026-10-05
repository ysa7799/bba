import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Loads the committed `.env.test` (local service URLs only, no secrets) unless the variables are
 * already provided by the environment (e.g. CI service containers).
 */
export function loadTestEnv(): void {
  if (process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL && process.env.REDIS_URL) {
    return;
  }
  process.loadEnvFile(path.join(repoRoot, '.env.test'));
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for tests`);
  }
  return value;
}
