// drizzle-kit emits FOREIGN KEY constraints before the CREATE UNIQUE INDEX statements that
// composite foreign keys reference, which Postgres rejects. This post-generate step hoists the
// unique index statements of the newest migration above its first foreign key. Index creation
// only depends on tables, so the reorder is always safe.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve(process.argv[2] ?? 'migrations');
const journal = JSON.parse(readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'));
const latest = journal.entries.at(-1);
if (!latest) process.exit(0);
const file = path.join(migrationsDir, `${latest.tag}.sql`);
const separator = '--> statement-breakpoint';
const statements = readFileSync(file, 'utf8')
  .split(separator)
  .map((statement) => statement.trim())
  .filter(Boolean);

const firstForeignKey = statements.findIndex((statement) => /FOREIGN KEY/.test(statement));
if (firstForeignKey === -1) process.exit(0);
const lateUniqueIndexes = statements
  .slice(firstForeignKey)
  .filter((statement) => /^CREATE UNIQUE INDEX/.test(statement));
if (lateUniqueIndexes.length === 0) process.exit(0);

const rest = statements.filter((statement) => !lateUniqueIndexes.includes(statement));
const insertAt = rest.findIndex((statement) => /FOREIGN KEY/.test(statement));
const ordered = [...rest.slice(0, insertAt), ...lateUniqueIndexes, ...rest.slice(insertAt)];
writeFileSync(file, `${ordered.join(`\n${separator}\n`)}\n`);
console.log(
  `order-migration: hoisted ${lateUniqueIndexes.length} unique index(es) in ${latest.tag}`,
);
