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

The web app rewrites `/api/*` to the API so cookies are first-party and CORS stays strict. The
API also supports a configured allow-list of origins for direct access.

## ADR-010 — Transactional outbox for domain events

Domain events are written in the same transaction as the state change and dispatched by the
worker. Guarantees at-least-once delivery without dual-write races; consumers are idempotent.
