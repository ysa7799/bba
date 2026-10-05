# Database

PostgreSQL 16+, Drizzle ORM (`packages/database`), node-postgres driver.

## Roles and connections

| Variable                 | Role                 | Used by                  | Notes                   |
| ------------------------ | -------------------- | ------------------------ | ----------------------- |
| `MIGRATION_DATABASE_URL` | owner (`businessos`) | `pnpm db:migrate`, seeds | Owns tables; runs DDL   |
| `DATABASE_URL`           | `businessos_app`     | api, worker, tests       | `NOBYPASSRLS`; DML only |

`pnpm db:setup` (`scripts/db/setup.sh` + `grant-app-role.sql`) creates the runtime role, the
dev/test databases and default privileges. Tests run
against `businessos_test` as the runtime role, so RLS is exercised in every test.

## Conventions

- Table names: plural `snake_case`. Columns: `snake_case`. TS fields: camelCase.
- Primary key `id uuid` (UUIDv7 from `newId()`).
- `created_at timestamptz not null default now()`, `updated_at timestamptz not null` on
  mutable tables. All timestamps UTC.
- Tenant tables: `organization_id uuid not null references organizations(id) on delete cascade`
  plus an index leading with `organization_id`.
- Tenant-scoped uniqueness: `unique (organization_id, …)`; case-insensitive emails use
  `lower(email)` expression indexes.
- Every FK states `ON DELETE` explicitly (`cascade`, `restrict` or `set null`).
- Enumerations: `text` + `CHECK` constraint (easier to evolve than PG enums).
- Money: `<name>_minor bigint` + `currency char(3)`; never `float`/`real`.
- JSON: `jsonb` only for genuinely schemaless data (metadata, provider payloads); never for
  fields that need filtering/reporting.

## Row-level security

Every tenant table gets (in its migration):

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (app_is_system() OR organization_id = app_current_org())
  WITH CHECK (app_is_system() OR organization_id = app_current_org());
```

`app_current_org()` / `app_is_system()` read transaction-local settings set by
`withTenant` / `withSystem`. A query outside either context sees no tenant rows.

## Migrations

- Generated with `drizzle-kit generate` from `packages/database/src/schema/*`, then reviewed.
  RLS policies, functions and expression indexes are added as hand-written SQL migrations.
- Applied with `pnpm db:migrate` (Drizzle migrator, owner role).
- Destructive changes follow expand → migrate → switch → contract across releases. Check
  locks, table size, nullability/defaults, index build strategy (`CONCURRENTLY` in a
  separate non-transactional migration for big tables), backfills and rollback before merging.

## Tables

Populated as phases land. See the schema files for the source of truth.

| Table      | Scope | Phase | Delete behaviour |
| ---------- | ----- | ----- | ---------------- |
| _none yet_ |       |       |                  |
