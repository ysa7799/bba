import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** Applies all pending migrations using the owner (migration) role. */
export async function runMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'businessos-migrate' });
  await client.connect();
  try {
    // Serialize concurrent migration runs (parallel CI jobs, multiple deploy replicas).
    await client.query('select pg_advisory_lock(727274)');
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    process.stderr.write('MIGRATION_DATABASE_URL is required\n');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      process.stdout.write('Migrations applied\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
