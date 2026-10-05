// `pnpm db:generate [--name=...] [--custom]`: runs drizzle-kit generate with the given flags,
// then fixes statement ordering in the new migration (see order-migration.mjs).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const generate = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (generate.status !== 0) process.exit(generate.status ?? 1);
const order = spawnSync('node', [path.join(here, 'order-migration.mjs'), 'migrations'], {
  stdio: 'inherit',
});
process.exit(order.status ?? 1);
