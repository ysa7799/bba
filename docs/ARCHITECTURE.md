# Architecture

Status: living document. Sections marked _(planned, Phase N)_ describe design that is not yet
implemented.

## 1. Shape: a modular monolith

```
                 ┌──────────────┐        ┌──────────────────────┐
 browser ───────▶│  apps/web    │──/api─▶│  apps/api (Fastify)  │──┐
                 │  Next.js UI  │rewrite │  HTTP layer only     │  │
                 └──────────────┘        └──────────┬───────────┘  │
 providers ─ webhooks ─────────────────────────────▶│              │
 developers ─ /api/v1 (API keys) ──────────────────▶│              │
                                                    ▼              ▼
                                      ┌──────────────────┐  ┌───────────┐
                                      │ packages/*       │  │ PostgreSQL│
                                      │ domain services  │─▶│ (RLS)     │
                                      │ + infrastructure │  └───────────┘
                                      └────────┬─────────┘  ┌───────────┐
                                               │  enqueue   │  Redis    │
                                               └───────────▶│ (BullMQ,  │
                                      ┌──────────────────┐  │ rate lim.)│
                                      │ apps/worker      │◀─┘───────────┘
                                      │ job processors   │──▶ providers (email, WhatsApp,
                                      └──────────────────┘    SMS, payments, storage, AI)
```

- One deployable API, one deployable worker, one web frontend. Services are split out later
  only for scale, isolation or reliability reasons (recorded in `DECISIONS.md`).
- **Domain services live in packages** so both the API and the worker can call them. The API
  layer does authentication, tenant resolution, permission checks, validation and
  serialization — nothing else.
- The web app never talks to the database and contains no business rules. It calls the API
  through a same-origin rewrite (`/api/*` → API), so session cookies are first-party.

## 2. Repository layout

```
apps/
  web/         Next.js (App Router), Tailwind CSS, accessible primitives
  api/         Fastify 5; routes grouped by module under src/modules/*
  worker/      BullMQ processors; outbox dispatcher; schedulers
packages/
  config/      shared tsconfig + eslint config, env-schema helpers
  shared/      errors, ids (UUIDv7), money, pagination, time, logging redaction
  database/    Drizzle schema, migrations, db client, scopes (withTenant/withUser/withSystem)
  organizations/ organization lifecycle, membership resolution, settings registry
  permissions/ permission catalogue, system roles, escalation guards
  auth/        accounts, sessions, passwords, invitations
  audit/ events/ jobs/  audit log, transactional outbox, job registry + queues
  billing/ payments/    plans, entitlements, usage; payment providers and checkout
  crm/         contacts, companies, pipelines, deals, tasks, notes, tags, custom fields,
               search, CSV import/export, timeline projectors
  activities/  customer timeline: type registry, recording, permission-gated reads,
               event projection subscriber
  files/       file storage port (S3 SigV4, local, memory), type sniffing, attachments with
               quota reservation, maintenance
  notifications/ notification catalogue, event subscriber with delivery re-checks, member
               inbox and channel preferences, retention
  testing/     dev-only fixtures (two-tenant world), Vitest global setup
  …            further packages are added only when code needs them (see ROADMAP)
```

Planned packages, created in the phase that needs them: `auth` (P3), `permissions` (P4),
`events`, `jobs`, `audit` (P5), `billing` (P6), `payments` (P7), `crm` (P8),
`communications` (P10), `calendar` (P11), `forms` (P12), `automation` (P13), `commerce` (P14),
`reporting` (P15),
`files`, `notifications` (P16), `integrations` (P18), `ui` (when the web app needs shared
primitives across more than one surface).

### Package conventions

- Source-only TypeScript packages: `"exports": { ".": "./src/index.ts" }`. The consuming app
  compiles them (tsup bundles internal packages for api/worker; Next uses
  `transpilePackages`). This avoids a build step per package and keeps type-checking exact.
- `moduleResolution: "Bundler"` everywhere; ESM only.
- Each package has `typecheck`, `lint`, `test` scripts; Turborepo orchestrates and caches
  (package sources are global cache inputs, ADR-031).
- Dependency direction: `apps → domain packages → infrastructure packages → shared`.
  Domain packages never import from apps. Provider adapters never leak into domains.

## 3. Multi-tenancy

**Tenant = Organization.** Child scoping concepts (workspace/location/branch/department) are
added only when a module needs them; they always sit _inside_ an organization.

Defense in depth, three layers:

1. **Request layer** — `requireOrgContext` resolves `{ user, organization, membership,
permissions }` from the session and the `:orgId` route param. The param is only a
   _selector_; access comes from an active membership. Non-members get `404`.
2. **Service/repository layer** — every query on a tenant table includes
   `organization_id = ctx.organizationId`. Foreign references supplied by the client
   (e.g. `companyId` on a contact) are verified to belong to the same organization.
3. **Database layer (PostgreSQL RLS)** — tenant tables have `FORCE ROW LEVEL SECURITY` with a
   policy `organization_id = current_setting('app.org_id')`. The API and worker connect as a
   non-owner role (`businessos_app`) without `BYPASSRLS`. `withTenant(orgId, fn)` runs `fn` in a
   transaction after `set_config('app.org_id', orgId, true)`. A forgotten `WHERE` therefore
   returns zero rows instead of another tenant's data.

`withUser(userId, fn)` sets only `app.user_id`: the user may read their own memberships and
the organizations they belong to (organization switcher), nothing tenant-internal.

`withSystem(fn)` sets `app.system = 'on'` for the transaction, which the policies honour. It is
used only for: authentication (global user/session tables), routing inbound webhooks to a
tenant, workers before they know the tenant, migrations/seeds, and platform admin. Uses are
greppable and reviewed.

Global (non-tenant) tables: `users`, `sessions`, auth tokens, `organizations` itself,
platform plans/feature flags, platform admin tables. Memberships are tenant-owned but a user may
also read their _own_ memberships across organizations (policy: `user_id = app.user_id`).

## 4. Request lifecycle (API)

```
request → request-id → security headers → rate limit → session/API-key auth
        → tenant resolution (membership) → permission check → Zod validation
        → domain service (withTenant transaction; outbox event; audit) → serializer → response
```

Errors are `AppError` subclasses mapped to a stable JSON envelope
`{ error: { code, message, details?, requestId } }` (see `API.md`). Unknown errors become
`500 internal_error` with no internals leaked; full context is logged server-side.

## 5. Data access

- **PostgreSQL 16+**, **Drizzle ORM** with `node-postgres`.
- Two connection roles: `MIGRATION_DATABASE_URL` (owner; runs migrations) and `DATABASE_URL`
  (runtime role subject to RLS).
- IDs are UUIDv7 (time-ordered, index friendly), generated in the app.
- Money: `bigint` minor units + `char(3)` currency columns; see `BILLING.md` and
  `packages/shared/src/money.ts`.
- Soft delete (`deleted_at`) for user-facing business records where recovery matters; hard
  delete flows for privacy requests. Decided per table in `DATABASE.md`.

## 6. Asynchronous work (Phase 5)

- **Transactional outbox**: domain services insert events into `outbox_events` in the same
  transaction as the state change. The worker's dispatcher claims rows
  (`FOR UPDATE SKIP LOCKED`), fans them out to subscribers (automation, webhooks,
  notifications, timeline) as BullMQ jobs, and marks them dispatched.
- **Jobs** behind a `JobQueue` interface (BullMQ adapter; in-memory adapter for tests).
  Retries with exponential backoff, idempotency keys, dead-letter visibility, structured logs.
- Durable workflow waits are stored in Postgres (`workflow_scheduled_steps`) and resumed by a
  scheduler, so Redis loss cannot drop a scheduled step _(Phase 13)_.
- Queues: `system`, `events`, `email`, `data` (CSV import/export, so bulk work never delays
  email or event delivery). Job payloads are validated against a registry
  (`packages/jobs/src/definitions.ts`) on enqueue and again before processing; unknown jobs and
  invalid payloads fail permanently. Exhausted jobs are persisted to `job_failures`.
- Emails (auth emails today) are `email.send` jobs rendered and delivered by the worker.
- The worker exposes `GET /health` on `WORKER_HEALTH_PORT` for orchestration.

## 7. Provider abstractions

Every external dependency sits behind a port with a registry of adapters and declared
capabilities: `PaymentProvider` (Tap, Phase 7), `ChannelProvider` (email/WhatsApp/SMS:
Postmark, WhatsApp Cloud API, Twilio, Phase 10), and later `StorageProvider`
(S3-compatible), `AIProvider`, `CalendarProvider`. Each has a fake adapter for tests/local
dev. Live adapters without credentials report `CONFIGURATION_REQUIRED`.

Communications (`@businessos/communications`) is tenant-configured: each organization
connects its own provider accounts as `channel_connections` with sealed credentials. Inbound
webhooks run route (URL token) → verify (provider signature) → normalize → dedupe → identify
or create the contact → resolve the conversation → store → emit events (→ timeline).
Outbound messages are stored as `queued` in the request transaction and delivered by the
`communications.send` job (claim → send → record), so a provider outage never loses a
message or blocks the inbox.

Scheduling (`@businessos/calendar`) computes availability on demand: weekly hours and date
overrides are expanded in each calendar's IANA zone (DST-safe `Intl` arithmetic), minus busy
blocks of existing bookings and external busy times, then filtered by notice/advance rules and
combined per scheduling mode (one host, round robin, team). Booking re-validates the slot and
inserts busy blocks guarded by a PostgreSQL exclusion constraint, which settles concurrent
bookings; round robin falls through to the next free host. Public booking pages and invitee
manage links are separate unauthenticated routes that resolve the tenant from a slug or token.

Forms (`@businessos/forms`) keep fields as rows of immutable versions (one draft, one
published). Loading a public form issues a render token (Redis); a submission is validated
against that version, checked for spam, stored idempotently and — unless quarantined — mapped
into the CRM in the same transaction (find-or-create contact, fill empty properties, tags,
deal, note; each step in a savepoint so a failed step becomes a note, not a lost submission)
with `form.submitted` in the outbox. The embed route gets its per-form `frame-ancestors` from
the web app's request proxy (`apps/web/src/proxy.ts`).

Commerce (`@businessos/commerce`) holds the catalogue (products, per-currency prices, tax
rates), quotes and invoices with server-computed lines (integer minor units, tax snapshots),
gapless invoice numbering, customer links, and invoice payments: online through the
organization's own provider connection (verified server-side, applied once) or recorded by
staff, plus refunds. It reuses the payments port and adapters but never the platform billing
flow. It is not a ledger: accounting arrives as a separate design phase.

Reporting (`@businessos/reporting`) answers dashboards and reports with bounded aggregate
queries over the live tables in the caller's tenant scope (no warehouse yet): periods are
resolved in the organization's time zone by PostgreSQL, money stays per currency, and every
report declares the read permission it needs. Results are plain data (metrics, series with
server-computed bar scales, tables) that the web app renders and the API can export as CSV.

Automation (`@businessos/automation`) stores workflows as versions with a trigger and a tree of
steps. The `automation` event subscriber starts runs for matching published workflows (unique
per workflow and event) and queues `automation.run`; the executor runs one step per
transaction until the run waits, finishes or fails. Waits and retry backoff are stored on the
run (`resume_at`) and picked up by `automation.resume` every minute, so they survive restarts
and a lost queue; the queue only speeds things up. Actions call the CRM and communications
services as the workflow actor; the webhook action is the only step performed outside a
transaction.

## 8. Frontend

- Next.js App Router, React 19, Tailwind CSS 4, accessible primitives (Radix-based,
  shadcn-compatible conventions).
- Routes: public auth pages, `/onboarding`, and the tenant app at `/o/[orgId]/…`.
- Data fetching through a typed API client; every view has loading / empty / error states.
- i18n-ready (English first, Arabic/RTL next): strings in message catalogs, logical CSS
  properties (`ms-*`, `pe-*`) so layouts flip for RTL.

## 9. Observability

pino structured logs with request IDs and correlation IDs propagated into jobs; redaction of
secrets; `/health/live` and `/health/ready` (DB + Redis); error-tracking and product-analytics
hooks behind interfaces (Sentry/PostHog-compatible), disabled without configuration.

## 10. Configuration

All configuration via environment variables validated with Zod at startup
(`apps/*/src/env.ts`). Separate env files per environment; no secrets in the repository.
See `DEPLOYMENT.md`.
