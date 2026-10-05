# Build Progress

## Current Phase

Phase 9 — Activity timeline

Status: NOT_STARTED

---

## Phase 8 — CRM

Status: PASSED

### Completed

- Schema (16 tables, all with FORCE RLS and composite same-tenant foreign keys): contacts,
  companies, contact↔company links, pipelines, stages, deals, tasks, notes, tags with
  per-entity join tables, custom field definitions, imports (+ staged rows), exports.
- `@businessos/crm`: contacts/companies/deals CRUD with soft delete, E.164 phone
  normalization in the organization's country, typed custom fields (13 types, validated per
  type, keyed by field id, JSONB containment filters), tags, contact↔company links with one
  primary company, pipelines/stages with structural guards, deal board with fractional
  positions and renormalization, won/lost/reopen transitions, tasks with timezone-aware due
  filters, notes (author or moderator), bulk actions, PostgreSQL search (tsvector prefix +
  phone digits + email/domain prefix), keyset pagination for every sort, entitlement limits
  (`crm.contacts.max`, `crm.pipelines.max`), CSV import (staging, mapping suggestions,
  preview, duplicate policy, resumable batches with per-row savepoints and errors) and async
  CSV export (formula-injection escaping, 24 h expiry, creator-only download).
- 21 `crm.*` permissions mapped to system roles; 16 CRM domain events; 15 CRM audit actions.
- API under `/app/orgs/:orgId/crm/*`; worker `data` queue with `crm.import`, `crm.export`
  and hourly `crm.maintenance`.
- Web: contacts, companies, deals board (drag and drop + keyboard-accessible move), tasks,
  record pages with notes/tasks/related records, import & export, CRM settings (pipelines,
  stages, custom fields, tags).

### Tests

- crm package (38): normalization, CSV parsing/escaping round trip, search sanitization,
  mapping suggestions; contacts (normalization, events, identity rule, per-tenant email
  uniqueness, owner must be an active member of the same tenant, change tracking, soft delete,
  company links, English/Arabic/phone/partial-email search with literal wildcards, keyset
  pagination over all five sorts, bulk actions skipping foreign ids, tags incl. foreign tag
  rejection); custom fields (all value types, required, unknown/archived keys, filters,
  immutability, duplicate keys); tenant isolation (RLS on direct read/update/insert, guessed
  ids, cross-tenant references rejected by services and by composite FKs, foreign pipeline
  stages, search); linked-name redaction; contact limit under 6 concurrent creates; pipeline
  limit; single default pipeline under concurrent first reads; deal transitions and event
  sequence; board ordering with 60 moves forcing renormalization and per-currency totals;
  negative values and explicit currency changes; pipeline structure guards; task due windows
  and completion events; note ownership; import (mapping, preview, duplicates, formula
  unescape, limit enforcement, idempotent re-run, cancellation, bad mappings, isolation);
  export (filters, formula escaping, creator-only download, cross-tenant).
- API (9 new, 124 total): role → capability matrix, 404 for non-members, link-read
  enforcement and name redaction, one test touching every CRM resource from another tenant
  (11 reads, 21 writes, bulk, references, lists, search), mass assignment, full HTTP workflow
  with validation errors, custom field filters and audit, import and export over HTTP
  including headers and audit.
- E2E (Playwright): contact → note → task → deal on the board → move to Won → CSV import via
  the worker → export download → search → other tenant gets 404.
- Full suite (uncached): 334 unit/integration + 6 E2E passing.

### Fixed during the phase

- Turborepo cache keys did not include internal package sources, so lint/typecheck/test/build
  could replay stale results after package changes (`globalDependencies` now hashes them).
- `foundation.test.ts` flushed the shared test Redis database while other files ran in
  parallel, intermittently erasing rate-limit counters (root cause of the earlier one-off
  rate-limit test failure). Removed; contexts already use unique key prefixes.
- A local Redis snapshot (`dump.rdb`, test counters only) had been committed; untracked and
  ignored.

### Risks

- Phone-digit search uses `LIKE '%digits%'` (unindexed within an organization); add trigram
  indexes in Phase 26 if needed.
- Import staging rows and export files live in Postgres until file storage (Phase 16).
- Contact counting for `crm.contacts.max` is O(contacts) per create; a counter can replace it
  in Phase 26.
- Arabic letter-variant normalization (أ/ا, ى/ي) is not applied to search yet.

### Next

- Phase 9: unified activity timeline across CRM records (notes, tasks, deal changes, future
  messages/appointments/invoices) with a cross-module-ready model.

---

## Phase 7 — Payments

Status: PASSED

### Completed

- Provider abstraction, Tap adapter (CONFIGURATION_REQUIRED), fake provider, payment service,
  webhooks with replay protection, subscription checkout/activation/maintenance, UI.

### Tests

- payments unit (11): Tap request shape (BHD decimals, BENEFIT source, callbacks, auth,
  idempotency), retrieval mapping, float-safe amount conversion, status mapping, forward-only
  transitions, configuration-required without network calls, error wrapping without leaking
  bodies, suspicious ids, hashstring computation, valid/missing/wrong/tampered signatures.
- payments integration (16): server-side pricing, private/free price refusal, pending sync is a
  no-op, 3 concurrent syncs fulfil once (items, billing event, payment event, entitlements),
  amount and currency tampering refused, no regression on stale responses, failed payments,
  early renewal extension, forged/unsigned webhooks rejected and recorded, signed webhook
  claiming success verified against the provider, replay deduplication, unknown
  payment/provider handling, tenant read-only RLS, past_due → paused lifecycle with
  entitlements, checkout expiry, month-end interval clamping.
- API (9): config, server pricing ignoring client amounts, permission + isolation, forged
  return-page hints ignored until provider confirms, no status write routes, raw-body
  signatures (tampered and re-serialized bodies rejected), replay, unknown provider, dev route
  creator guard, production env refusal.
- E2E: hosted checkout subscription flow (forged return visit first, then real payment).
- Full suite: 285 unit/integration + 5 E2E passing.

### Risks

- Tap integration unverified against a live sandbox (no credentials): CONFIGURATION_REQUIRED.
- Refund notifications are not processed yet (Phase 14 commerce refunds).
- Recurring card charging not implemented (ADR-026).

### Next

- Phase 8: CRM — contacts, companies, pipelines, stages, deals, tasks, notes, tags, custom
  fields with tenant isolation and E2E.

---

## Phase 6 — Billing + Entitlements

Status: PASSED

### Completed

- Plans as data with versions, prices (BHD minor units) and typed entitlements; resolution with
  overrides and a restrictive fallback; subscriptions changed only via system paths.
- Atomic, idempotent monthly quota metering in the organization's timezone; seat limits.
- Billing endpoints and page; example catalogue seed.

### Tests

- billing (20): registry validation, timezone periods, catalogue versioning/visibility,
  invalid catalogue input, unpublished versions refused, fallback/plan/past_due/paused
  resolution, override precedence and expiry, plan change events, default plan subscription
  (rolled-back transaction), single live subscription, tenant write attempts blocked by RLS
  (subscriptions, overrides, billing events, catalogue), tenant read isolation, 25 concurrent
  consumes → exactly 10 succeed, idempotency keys, rollback on exceeded quota, unlimited
  quotas, local-month metering, cross-tenant consumption blocked, concurrent seat reservation.
- API (13): invitation limit 402, re-invite seat neutrality, 6 concurrent invites → 2 succeed,
  join blocked after downgrade, reactivation blocked, read-only entitlements, tenant isolation,
  no subscription write routes / smuggled fields, billing permission, profile validation and
  audit, catalogue prices as BHD decimal strings.
- Full suite: 248 unit/integration + 4 E2E passing.

### Risks

- Gauge limits beyond seats are enforced as modules land (contacts, pipelines, workflows,
  storage).
- Annual vs monthly quota alignment is calendar-month only (ADR-024).

### Next

- Phase 7: payment provider abstraction, Tap adapter, webhooks, checkout for subscriptions.

---

## Phase 5 — Audit + Events + Jobs

Status: PASSED

### Completed

- Append-only audit log covering auth and organization administration, with UI.
- Domain events via transactional outbox; dispatcher with SKIP LOCKED, leases, backoff and
  failed state; subscriber registry; once-only processing helper.
- Typed job system (BullMQ) with retries/backoff, payload validation, idempotent enqueue,
  dead-letter persistence; emails moved to `email.send` jobs; worker health endpoint.

### Tests

- worker (14, real Redis + Postgres): delivery with full envelope, rollback emits nothing,
  invalid event payloads rejected, cross-tenant emit blocked by RLS, transient failure retries
  with backoff, unrecoverable failures dead-lettered, invalid job payloads fail permanently,
  re-dispatch delivers once, `processOnce` dedupe, concurrent dispatchers exactly-once,
  crash-recovery reclaim, system.ping, email delivery, enqueue validation.
- events (5): fan-out with deterministic ids, no-subscriber dispatch, enqueue-failure backoff
  → failed, not-yet-due events untouched, registry validation.
- jobs (5), API audit/events (8): attribution, permission + tenant isolation, pagination and
  filter validation, append-only enforcement (tenant and system scope), security events
  without secrets, events with correlation ids, rejected actions emit nothing, queued email.
- Full suite: 215 unit/integration + 4 E2E passing.

### Risks

- Outbox and processed_events need retention/cleanup jobs (Phase 26/29).
- Email delivery is CONFIGURATION_REQUIRED in production until a provider adapter lands.

### Next

- Phase 6: plans, plan versions, prices, subscriptions, entitlements, usage metering with
  server-side enforcement.

---

## Phase 4 — RBAC

Status: PASSED

### Completed

- Permission catalogue (organization.update, settings.users.manage, settings.roles.manage),
  five system roles derived from code, custom roles, multi-role assignments.
- Escalation guards: subset rule for granting/defining/inviting, no managing more powerful
  members, owner-only owner grants, at-least-one-owner invariant with organization row lock.
- Member management, role management, invitation management, organization settings — API + UI.

### Tests

- permissions: 10 unit tests (catalogue integrity, derivation, filtering, guards).
- API RBAC suite: 37 tests — permission matrix (403 for members, 404 for non-members on every
  guarded endpoint), owner-grant attempts, managing owners, delegated manager escalation
  attempts (assign, self-assign, define role, invite), system role immutability, unknown
  permissions, immediate effect of role changes, cross-tenant role/member/invitation/role-edit
  references, DB-level rejection of cross-tenant assignments, last-owner rules, ownership
  transfer, concurrent demotion race, suspension/removal effects, invited role assignment.
- E2E: invite → accept → restricted UI → promotion takes effect.
- Full suite: 186 unit/integration + 4 E2E passing.

### Risks

- Permission resolution adds one query per tenant request (inside the same tenant transaction
  as membership resolution). Revisit with caching in Phase 26 if needed.

### Next

- Phase 5: audit log, domain events with transactional outbox, job abstraction with retries,
  idempotency and dead-letter visibility; audit existing sensitive actions.

---

## Phase 3 — Authentication

Status: PASSED

### Completed

- Registration, email verification, login, logout, sessions, forgot/reset password, change
  password, invitation preview/acceptance (existing and new accounts), organization creation
  and switching — API and web UI.
- Hardening: enumeration-resistant responses, timing equalization, per-account lockout and
  per-IP limits, session fixation prevention, token single-use and email binding, CSRF origin
  check, `__Host-` cookies in production, open-redirect guard, `no-store`, proxy trust config.

### Tests

- auth package: 24 (registration branches, pre-hijack, verification, expiry, rehash, reset,
  change password, invitations incl. cross-tenant invitation attempt).
- API: 49 (protected-route matrix, cookie attributes, forged/revoked cookies, fixation, reset
  revocation, CSRF, non-JSON refusal, org creation/switching, mass assignment, cross-tenant
  404s, suspended membership, invitation flows, strict rate limits).
- Web unit: 9 (redirect validation). E2E (Playwright): 3 full-stack flows.
- Full suite: 138 unit/integration + 3 E2E passing.

### Risks

- Production cannot start until an email provider exists (by design, CONFIGURATION_REQUIRED).
- Global rate limit is per IP; authenticated per-user limits are applied per sensitive route.
- A one-off failure of the per-IP registration limit test was seen once and not reproduced in
  9 further runs; the assertion now prints the full status list if it recurs.

### Next

- Phase 4: permission catalogue, system + custom roles, assignments, escalation guards,
  member management and invitation endpoints with permission checks.

---

## Phase 2 — Database + Tenancy

Status: PASSED

### Completed

- Tables: users (global), organizations (tenant root), memberships, organization_settings.
- RLS on every table, `FORCE ROW LEVEL SECURITY`, policies driven by transaction-local
  settings; runtime role sees nothing outside a scope.
- Scoped transaction helpers with branded types; Postgres error helpers.
- Organizations domain package (create/list/resolve/update/members/settings).
- Decision: no workspace/location tier yet (ADR-011).

### Tests

- 24 tenancy tests: RLS coverage guard (every public table must have RLS enabled, forced and
  policies), no access outside scope, Org A cannot read/list/search/update/delete/insert/move
  rows into Org B, guessed IDs return nothing/404, no context leakage across pooled
  connections, malformed scope ids rejected, multi-org users isolated per tenant, suspended
  members and inactive organizations denied, settings isolation and validation, slug
  allocation (incl. Arabic names), regional validation.
- Full suite: 73 passing.

### Risks

- RLS subqueries on `memberships` for `users`/`organizations` visibility; indexed, revisit in
  Phase 26 with real query plans.
- HTTP-level tenant resolution arrives with authentication in Phase 3.

### Next

- Phase 3: registration, verification, login/logout, sessions, password reset, invitations,
  organization creation and switching over HTTP.

---

## Phase 1 — Monorepo Foundation

Status: PASSED

### Completed

- pnpm workspace + Turborepo (`build`, `lint`, `typecheck`, `test`, `dev`), Prettier,
  EditorConfig, `.nvmrc`, `.env.example`, committed `.env.test` (local URLs only).
- `packages/config`: shared tsconfig bases (strict, `noUncheckedIndexedAccess`, Bundler
  resolution), type-aware flat ESLint config (typescript-eslint strict), Next ESLint config,
  Zod env helpers.
- `packages/shared`: `AppError` hierarchy, UUIDv7 `newId()` (monotonic), BHD-correct `Money`
  (bigint minor units, currency registry, rounding modes, allocation, VAT-style percentages),
  cursor pagination helpers, log redaction.
- `packages/database`: Drizzle + node-postgres client (int8 never parsed as float),
  advisory-locked migration runner, readiness ping, foundation migration with RLS helper
  functions (`app_current_org()`, `app_current_user()`, `app_is_system()`).
- `apps/api`: Fastify 5 app factory with validated env (production refuses http origins),
  pino with redaction, request IDs (safe upstream propagation), helmet, CORS allow-list,
  Redis-backed global rate limit, standard error envelope (no internals leaked),
  `/health/live` + `/health/ready`, graceful shutdown.
- `apps/worker`: BullMQ bootstrap, validated env, `system.ping` processor, failure logging,
  graceful shutdown.
- `apps/web`: Next.js 16 + Tailwind 4 skeleton, `/api/*` same-origin rewrite, security headers,
  real `/status` page backed by `/health/ready`.
- `docker-compose.yml` (Postgres 16, Redis 7), `pnpm db:setup` (runtime role `businessos_app`,
  NOSUPERUSER/NOBYPASSRLS), CI workflow (format, migration sync, lint, typecheck, test, build).
- `scripts/verify-bundle-deps.mjs`: build fails if a bundled app imports an undeclared package.

### Tests

- 49 passing: shared (27), database (3, incl. runtime role has no RLS bypass), api (17: health,
  request ids, error envelope, no internal leakage, mass-assignment stripping, malformed JSON,
  body limit, security headers, CORS allow-list, rate limiting), worker (2: job round trip,
  unknown job fails visibly).
- Manual smoke: built API and worker start, serve health, shut down gracefully.

### Risks

- Rate limiter fails open if Redis is unavailable (availability choice; readiness reports it).
  Auth-specific limits in Phase 3 will be reconsidered.
- CI workflow not yet executed on GitHub (cannot run Actions from the sandbox).

### Next

- Phase 2: users, organizations, memberships, settings, tenant context, RLS policies,
  cross-tenant tests.

---

## Phase 0 — Repository Audit

Status: PASSED

### Completed

- Audited repository: Vercel "Express on Vercel" sample only. Decision: replace (ADR-002).
- Environment: Node 22.22, pnpm 10.28, PostgreSQL 16 and Redis available locally; Docker
  daemon unavailable in the build sandbox (docker-compose provided for developers).
- Created CLAUDE.md and the docs set.

### Risks

- Scope is very large; phases must stay disciplined to avoid shallow breadth.
- RLS adds a transaction per tenant request; re-evaluate in Phase 26.
