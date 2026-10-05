# Architecture Decision Log

Format: context → decision → consequences. Newest at the bottom. Superseded decisions are
marked, never deleted.

## ADR-001 — Modular monolith with domain packages

**Context.** The product spans many modules that share one data model and must be built fast
without sacrificing isolation. **Decision.** One API app, one worker app, one web app. Domain
services live in `packages/*` so both API and worker use them. **Consequences.** Simple deploys
and transactions across modules; package boundaries must be enforced by review and lint rules.
Services are extracted only with recorded justification.

## ADR-002 — Replace the Vercel Express sample

**Context.** The repository contained only the Vercel "Express on Vercel" example (one route
file, static assets). **Decision.** Remove it in Phase 1 and build the target monorepo.
**Consequences.** No migration needed; nothing of value is lost.

## ADR-003 — Stack

pnpm + Turborepo, TypeScript strict (6.0.x — the newest line supported by typescript-eslint),
Next.js 16 / React 19 / Tailwind 4 (web), Fastify 5 (api), BullMQ 5/6 + Redis (jobs),
PostgreSQL 16 + Drizzle ORM + node-postgres, Zod 4, Vitest, Playwright, pino.

## ADR-004 — Source-only internal packages

**Decision.** Internal packages export TypeScript source; apps compile them (tsup / Next
`transpilePackages` / Vitest). `moduleResolution: Bundler`. **Consequences.** No per-package
build step or stale `dist`; api/worker production output is a bundle with external npm deps.

## ADR-005 — Postgres Row-Level Security as a third isolation layer

**Context.** A missing `WHERE organization_id = …` is the most likely cross-tenant bug.
**Decision.** Tenant tables use `FORCE ROW LEVEL SECURITY` with a policy on
`current_setting('app.org_id')`. Runtime connects as a non-owner role without `BYPASSRLS`;
`withTenant` sets the setting per transaction. `withSystem` sets `app.system='on'` for the
narrow set of legitimate cross-tenant operations. **Consequences.** Every tenant query runs in
a transaction (small overhead); migrations run as the owner role; tests run as the runtime role
so RLS is exercised.

## ADR-006 — UUIDv7 primary keys generated in the application

Time-ordered (B-tree friendly), non-enumerable enough for public use when combined with
authorization, generated without DB round-trips.

## ADR-007 — Money as integer minor units

`bigint` minor units + ISO 4217 currency code on every monetary record; `Money` helpers use
JS `bigint`. Currency exponents come from a registry (BHD/KWD/OMR/JOD = 3, JPY = 0, …). API
represents amounts as decimal strings with an explicit currency. No implicit conversion.

## ADR-008 — Opaque server-side sessions (not JWT)

Sessions are random tokens whose SHA-256 hash is stored in Postgres; revocation is immediate and
no signing secret can be leaked to forge sessions. JWTs may be used later only for short-lived
service-to-service tokens.

## ADR-009 — Same-origin API access from the web app

The web app proxies `/api/*` to the API so cookies are first-party and CORS stays strict. The
API also supports a configured allow-list of origins for direct access. _Amended in Phase 3:_
Next.js `rewrites` bake the destination at build time, so the proxy is a runtime route handler
(`apps/web/src/app/api/[...path]/route.ts`) with header allow-lists in both directions.

## ADR-010 — Transactional outbox for domain events

Domain events are written in the same transaction as the state change and dispatched by the
worker. Guarantees at-least-once delivery without dual-write races; consumers are idempotent.

## ADR-011 — No workspace/location tier yet

Workspaces/locations/branches are not created until a module needs them (likely calendar
availability per branch or white-label sub-accounts). When added they live inside an
organization and never replace `organization_id` as the isolation key.

## ADR-012 — Typed settings registry

Organization settings are key/value rows validated against a code registry (Zod schema +
default per key). Unknown keys are rejected; invalid stored values fall back to defaults.
Settings that need relational queries get dedicated tables.

## ADR-013 — Three DB scopes with branded transaction types

`withTenant`, `withUser` and `withSystem` set transaction-local settings consumed by RLS
policies. User-scope clauses (own memberships/organizations) only apply when no organization is
set, so tenant queries can never return another tenant's rows even for multi-org users.

## ADR-014 — Shared test fixtures package

`@businessos/testing` builds the standard two-tenant world through real domain code paths. It is
a dev-only dependency; Turborepo tasks do not declare `^task` dependencies (internal packages
are source-only, ADR-004), so the dev-only package cycle is harmless.

## ADR-015 — Email verification required before sign-in

Accounts must verify their email before password sign-in; verification does not sign the user
in. Invitation acceptance and password reset prove mailbox ownership and therefore verify the
email. Until the notification/email provider phase, auth emails go through an `AuthMailer` port
with development transports only (log/file/memory); production refuses to start without a real
provider (`CONFIGURATION_REQUIRED`).

## ADR-016 — Identity providers prepared, not implemented

`sessions.auth_method` and `sessions.mfa_verified_at` exist so OAuth (Google/Microsoft), MFA,
passkeys and SAML can be added without reshaping sessions. External identities will live in a
separate `user_identities` table; `users.password_hash` is nullable for passwordless accounts.

## ADR-017 — System roles resolve from code; permissions ship with features

System roles are rows (so they can be assigned and referenced by FKs) but their permissions are
derived from the catalogue at evaluation time, so a release that adds a permission updates every
organization's system roles without data migrations. Custom roles store explicit lists and only
gain new permissions when an admin adds them. Permissions enter the catalogue in the phase that
implements the guarded feature.

## ADR-018 — Same-tenant integrity with composite foreign keys

Join tables that reference two tenant-owned rows carry `organization_id` and use composite
foreign keys `(id, organization_id)` to both parents. Cross-tenant links are impossible even for
code running in system scope. This pattern applies to all future tenant join tables.

## ADR-019 — Tenant access data is fetched per page, not per layout

Next.js App Router layouts are not re-rendered on client navigation, so permission data fetched
in a layout goes stale after a role change. Tenant pages fetch access themselves (deduplicated
per request with React `cache`) and provide it to client components.
