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
- Every FK states `ON DELETE` explicitly (`cascade`, `restrict` or `set null`), except links
  between soft-deleted CRM records, which use `NO ACTION` on purpose (ADR-027).
- Enumerations: `text` + `CHECK` constraint (easier to evolve than PG enums).
- Money: `<name>_minor bigint` + `currency char(3)`; never `float`/`real`.
- JSON: `jsonb` only for genuinely schemaless data (metadata, provider payloads); never for
  fields that need filtering/reporting — tenant-defined custom field values are the documented
  exception (ADR-028).

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

`pnpm db:generate` runs `drizzle-kit generate` followed by `scripts/db/order-migration.mjs`, which
hoists `CREATE UNIQUE INDEX` statements above foreign keys in the new migration (drizzle-kit
emits composite foreign keys before the unique indexes they reference).

### Migration details

- Generated with `drizzle-kit generate` from `packages/database/src/schema/*`, then reviewed.
  RLS policies, functions and expression indexes are added as hand-written SQL migrations.
- Applied with `pnpm db:migrate` (Drizzle migrator, owner role).
- Destructive changes follow expand → migrate → switch → contract across releases. Check
  locks, table size, nullability/defaults, index build strategy (`CONCURRENTLY` in a
  separate non-transactional migration for big tables), backfills and rollback before merging.

## Tables

Populated as phases land. See the schema files for the source of truth.

| Table                                                                  | Scope                                                                                                                                  | Phase | Delete behaviour                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `users`                                                                | global (RLS: self, co-members, system)                                                                                                 | 2     | hard delete cascades memberships (privacy flow later)                                       |
| `organizations`                                                        | tenant root (RLS: own tenant, members\*)                                                                                               | 2     | soft delete (`deleted_at`); hard delete cascades all tenant rows                            |
| `memberships`                                                          | tenant                                                                                                                                 | 2     | cascade with organization or user                                                           |
| `organization_settings`                                                | tenant                                                                                                                                 | 2     | cascade with organization; `updated_by_user_id` set null on user delete                     |
| `sessions`                                                             | global (RLS: own user, system)                                                                                                         | 3     | cascade with user; `active_organization_id` set null                                        |
| `auth_tokens`                                                          | global (RLS: system only)                                                                                                              | 3     | cascade with user                                                                           |
| `invitations`                                                          | tenant                                                                                                                                 | 3     | cascade with organization; inviter/acceptor set null; role RESTRICT                         |
| `roles`                                                                | tenant                                                                                                                                 | 4     | cascade with organization                                                                   |
| `membership_roles`                                                     | tenant (composite same-tenant FKs)                                                                                                     | 4     | cascade with membership; role RESTRICT                                                      |
| `audit_logs`                                                           | tenant or account-level (org null); append-only (no UPDATE/DELETE policies)                                                            | 5     | cascade with organization; actor set null                                                   |
| `outbox_events`                                                        | tenant insert; system read/update                                                                                                      | 5     | cascade with organization                                                                   |
| `processed_events`                                                     | system only                                                                                                                            | 5     | retention job later                                                                         |
| `job_failures`                                                         | system only                                                                                                                            | 5     | organization set null                                                                       |
| `plans`, `plan_versions`, `plan_entitlements`, `prices`                | platform catalogue (read: all; write: system)                                                                                          | 6     | RESTRICT from versions/prices/subscriptions                                                 |
| `billing_customers`                                                    | tenant                                                                                                                                 | 6     | cascade with organization                                                                   |
| `subscriptions`, `subscription_items`                                  | tenant read-only (write: system)                                                                                                       | 6     | cascade with organization; plan version RESTRICT                                            |
| `entitlement_overrides`, `billing_events`                              | tenant read-only (write: system)                                                                                                       | 6     | cascade with organization                                                                   |
| `usage_counters`, `usage_records`                                      | tenant                                                                                                                                 | 6     | cascade with organization                                                                   |
| `payments`                                                             | tenant read-only (write: system)                                                                                                       | 7     | organization RESTRICT (financial record)                                                    |
| `checkout_sessions`                                                    | tenant read-only (write: system)                                                                                                       | 7     | cascade with organization; payment RESTRICT                                                 |
| `payment_webhook_events`                                               | system only                                                                                                                            | 7     | organization set null                                                                       |
| `crm_contacts`, `crm_companies`, `crm_deals`                           | tenant; soft delete; generated `search_vector`                                                                                         | 8     | cascade with organization; links NO ACTION (ADR-027)                                        |
| `crm_contact_companies`, `crm_*_tags`                                  | tenant (composite same-tenant FKs)                                                                                                     | 8     | cascade with either side                                                                    |
| `crm_pipelines`, `crm_pipeline_stages`                                 | tenant; stages unique per `(id, pipeline_id)` for deal FK                                                                              | 8     | archive pipelines; stages deleted only when empty                                           |
| `crm_tasks`, `crm_notes`                                               | tenant; soft delete; notes have exactly one parent                                                                                     | 8     | cascade with organization (notes cascade with parent)                                       |
| `crm_tags`, `crm_custom_fields`                                        | tenant                                                                                                                                 | 8     | cascade with organization                                                                   |
| `crm_imports`, `crm_import_rows`                                       | tenant                                                                                                                                 | 8     | staging rows purged 30 days after completion                                                |
| `crm_exports`                                                          | tenant; content readable only by the creator via the API                                                                               | 8     | file content cleared at expiry (24 h)                                                       |
| `activities`                                                           | tenant; per-row `required_permission`; unique `source_event_id`                                                                        | 9     | cascade with organization; record links NO ACTION (ADR-027)                                 |
| `channel_connections`                                                  | tenant; sealed credentials; webhook token stored as SHA-256 hash                                                                       | 10    | disconnect (status) keeps history; cascade with organization                                |
| `conversations`                                                        | tenant; unique per connection + counterpart address                                                                                    | 10    | cascade with organization; contact link NO ACTION; assignee set null                        |
| `conversation_participants`, `conversation_tags`                       | tenant (composite same-tenant FKs)                                                                                                     | 10    | cascade with conversation (tags also with tag)                                              |
| `messages`, `message_attachments`                                      | tenant; unique provider message id per connection                                                                                      | 10    | cascade with conversation; author set null                                                  |
| `channel_templates`                                                    | tenant; WhatsApp templates per connection                                                                                              | 10    | cascade with connection                                                                     |
| `communication_webhook_events`                                         | system only (dedupe + audit of provider callbacks)                                                                                     | 10    | organization set null                                                                       |
| `calendars`                                                            | tenant; one personal calendar per member (unique org + user)                                                                           | 11    | deactivate; cascade with organization; user set null                                        |
| `calendar_availability_rules`, `calendar_availability_exceptions`      | tenant; minutes in the calendar's zone                                                                                                 | 11    | cascade with calendar                                                                       |
| `appointment_types`, `appointment_type_hosts`                          | tenant; slug unique per organization                                                                                                   | 11    | types deactivated, never deleted (NO ACTION from appointments)                              |
| `booking_pages`, `booking_page_types`                                  | tenant; slug globally unique (public URL)                                                                                              | 11    | delete only while unused (NO ACTION from appointments)                                      |
| `appointments`, `appointment_participants`                             | tenant; status, invitee snapshot, reminder state                                                                                       | 11    | cancelled, never deleted; contact NO ACTION (ADR-027)                                       |
| `calendar_busy_blocks`                                                 | tenant; **exclusion constraint** — no overlapping blocks per calendar                                                                  | 11    | removed on cancel; cascade with appointment/calendar                                        |
| `appointment_manage_tokens`                                            | tenant; SHA-256 of invitee link tokens, expiring                                                                                       | 11    | cascade with appointment                                                                    |
| `calendar_connections`, `appointment_external_events`                  | tenant; sealed credentials; mirrored external events                                                                                   | 11    | disconnect (status); cascade with calendar                                                  |
| `forms`                                                                | tenant; slug globally unique (public URL); active/archived                                                                             | 12    | archived, never deleted; cascade with organization                                          |
| `form_versions`                                                        | tenant; one draft and one published per form (partial unique indexes)                                                                  | 12    | published/retired immutable; drafts deletable; cascade with form                            |
| `form_fields`                                                          | tenant; answer key unique per version; allow-listed CRM target                                                                         | 12    | cascade with version                                                                        |
| `automation_workflows`                                                 | tenant; status draft/active/paused/archived; SHA-256 of the inbound webhook token (unique)                                             | 13    | archived, never deleted; cascade with organization                                          |
| `automation_workflow_versions`, `automation_nodes`, `automation_edges` | tenant; one draft and one published per workflow; one way into every node (unique `to`)                                                | 13    | published/retired immutable; cascade with version                                           |
| `automation_runs`                                                      | tenant; unique per (workflow, trigger occurrence); chain depth; resume time; deadline                                                  | 13    | kept; contact/deal NO ACTION; version NO ACTION                                             |
| `automation_run_steps`, `automation_run_logs`                          | tenant; unique step per (run, node)                                                                                                    | 13    | cascade with run                                                                            |
| `form_submissions`                                                     | tenant; validated answers, accepted/spam, unique render-token key per form                                                             | 12    | kept; contact/deal links NO ACTION (ADR-027); version NO ACTION                             |
| `commerce_settings`                                                    | tenant (one row per organization); next invoice/quote numbers, prefixes, terms, footer                                                 | 14    | cascade with organization                                                                   |
| `commerce_tax_rates`, `commerce_products`, `commerce_product_prices`   | tenant; SKU unique per organization (case-insensitive); one live price per product and currency                                        | 14    | archived, never deleted (documents keep snapshots); prices cascade with product             |
| `commerce_quotes`, `commerce_invoices`                                 | tenant; number unique per organization (invoices: when issued); SHA-256 of the customer link token (unique); totals in minor units     | 14    | issued invoices are voided, never deleted; drafts deletable; contact/company/deal NO ACTION |
| `commerce_quote_items`, `commerce_invoice_items`                       | tenant; quantity `numeric(12,3)`; tax name/rate snapshot; amounts computed by the server                                               | 14    | cascade with the document                                                                   |
| `commerce_payment_connections`                                         | tenant; sealed provider credentials; one live connection per organization                                                              | 14    | disconnect erases credentials; cascade with organization                                    |
| `commerce_checkouts`                                                   | tenant; online payment attempts (unique payment)                                                                                       | 14    | kept; payment and invoice NO ACTION                                                         |
| `commerce_invoice_payments`                                            | tenant; online (verified payment, unique) or manual; refunded ≤ amount                                                                 | 14    | kept (financial record)                                                                     |
| `commerce_refunds`                                                     | tenant; pending/succeeded/failed, provider refund id                                                                                   | 14    | kept (financial record)                                                                     |
| `files`                                                                | tenant; pending/ready/deleted, size, SHA-256, unique storage key; attached record (contact, company or deal)                           | 16    | soft delete, object purged by the worker; cascade with organization; uploader set null      |
| `notifications`                                                        | **owner only** (organization + user); unique per (user, type, source event); in-app link must start with `/o/<id>/`                    | 16    | read ones kept 90 days, unread one year (worker); cascade with organization and user        |
| `notification_preferences`                                             | **owner only**; one row per (organization, user, type): in-app and email switches                                                      | 16    | cascade with organization and user                                                          |
| `api_keys`                                                             | tenant; SHA-256 of the key (unique; the key is never stored), display prefix, scopes, creator, expiry                                  | 17    | revoked, never deleted; cascade with organization                                           |
| `api_idempotency_keys`                                                 | tenant; unique per (key, idempotency key); request fingerprint and the first successful response                                       | 17    | pruned after 24 hours (worker); cascade with the API key                                    |
| `webhook_endpoints`                                                    | tenant; URL, subscribed events, sealed signing secret (and the previous one during a rotation), on/off with reason, failure count      | 17    | deleted with their deliveries; cascade with organization                                    |
| `integration_accounts`                                                 | tenant; provider, account id and label, scopes, sealed tokens, expiry, state (`connecting/active/refresh_required/error/disconnected`) | 18    | disconnected (tokens erased), never deleted; cascade with organization                      |
| `integration_oauth_states`                                             | tenant; SHA-256 of the OAuth `state` (unique), sealed PKCE verifier, member, purpose and context; single use, 10 minutes               | 18    | removed by the worker a day after expiry                                                    |
| `webhook_deliveries`                                                   | tenant; unique per (endpoint, event); the exact body sent, status, attempts, next attempt, last response                               | 17    | pruned after 30 days (worker); cascade with endpoint (composite same-tenant FK)             |

\* Members see their organizations only in user scope (no organization selected); inside a
tenant context only that tenant is visible.

### Constraints beyond Drizzle

- `calendar_busy_blocks_no_overlap` (migration 0022): `EXCLUDE USING gist (calendar_id WITH =,
tstzrange(starts_at, ends_at, '[)') WITH &&)`. Needs the `btree_gist` extension (trusted since
  PostgreSQL 13: the database owner can create it). Booking code relies on it to settle races
  (SQLSTATE `23P01`), so it must exist in every environment.
- Commerce money columns are `bigint` minor units with an explicit `char(3)` currency on every
  document, line, payment and refund (checks: amounts ≥ 0, payments > 0, refunded ≤ amount,
  online ⇔ payment id). `payments.purpose` is `subscription` or `invoice`; invoice payments
  are verified through the organization's own connection, never the platform's.
- Reporting indexes (migration 0029) cover per-period aggregates: `(organization_id, created_at)`
  on messages and conversations, `(organization_id, submitted_at)` on form submissions,
  `(organization_id, started_at)` on workflow runs, `(organization_id, received_at)` on invoice
  payments, `(organization_id, created_at)` on refunds, and partial `(organization_id,
closed_at|completed_at|issue_date)` on deals, tasks and invoices. Built with plain
  `CREATE INDEX` because no production data exists yet; once it does, new indexes on large
  tables go in their own `CREATE INDEX CONCURRENTLY` migration.
- Files and notifications (migrations 0030–0032): `files_status_check`, `files_name_check`
  (1–200 characters) and a record-type check; `notifications` and `notification_preferences`
  use the policy `app_is_system() OR (organization_id = app_current_org() AND user_id =
app_current_user())` — a member's notifications are invisible to other members of the same
  organization, not just to other tenants (FORCE RLS like every tenant table).
  `notifications_created_idx` serves the retention sweep.
- Developers (migrations 0033–0034, FORCE RLS): API keys are looked up by the SHA-256 of the
  presented key in system scope (the key is what identifies the tenant, like a session);
  everything else runs in the key's tenant scope. Idempotency records reference their key
  through a composite `(api_key_id, organization_id)` FK; deliveries reference their endpoint
  the same way.
- Connected accounts (migrations 0035–0036, FORCE RLS): a check keeps tokens present exactly
  while an account is connected and erased once disconnected; one live account per
  (organization, provider, provider account). `calendar_connections.integration_account_id`
  references it through a composite same-tenant FK. OAuth states are found by the hash of the
  returned `state` in system scope (the state identifies the organization on return).
- A transaction is one connection: never run queries concurrently on it (`Promise.all` over
  `tx` queries); `pg` serializes them anyway and will reject it in its next major version.

### Scopes

| Helper                        | Settings                    | Sees                                                        |
| ----------------------------- | --------------------------- | ----------------------------------------------------------- |
| `withTenant(db, {org, user})` | `app.org_id`, `app.user_id` | that organization's rows; member users                      |
| `withUser(db, userId)`        | `app.user_id`               | own user row, own memberships, organizations they belong to |
| `withSystem(db)`              | `app.system = on`           | everything — justified call sites only                      |
| none                          | —                           | nothing (all tables return zero rows)                       |

Transaction handles are branded (`TenantTx`, `UserTx`, `SystemTx`) so a function that requires
tenant scope cannot be handed an unscoped or system transaction by mistake.
