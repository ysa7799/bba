# Build Progress

## Current Phase

Phase 5 — Audit + Events + Jobs

Status: IN_PROGRESS

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
