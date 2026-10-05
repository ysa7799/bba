# Build Progress

## Current Phase

Phase 2 — Database + Tenancy

Status: IN_PROGRESS

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
