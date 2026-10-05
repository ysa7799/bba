import { createDatabase } from '@businessos/database';
import { seedExampleCatalog } from './seed';

/** `pnpm db:seed` — loads the example plan catalogue into the development database. */
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const handle = createDatabase({ url, maxConnections: 1 });
  try {
    await seedExampleCatalog(handle.db);
    process.stdout.write('Example plan catalogue seeded\n');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
