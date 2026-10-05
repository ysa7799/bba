# Roadmap

Phases execute in order. A phase is complete only when its quality gate passes (see
`CLAUDE.md` and the Definition of Done in `docs/TESTING.md`). Live status per phase is in
`docs/BUILD_PROGRESS.md`.

| #   | Phase                                                   | Quality gate                                       | Status      |
| --- | ------------------------------------------------------- | -------------------------------------------------- | ----------- |
| 0   | Repository audit & documentation                        | Architecture internally consistent                 | PASSED      |
| 1   | Monorepo foundation                                     | lint, typecheck, tests, build                      | PASSED      |
| 2   | Database + tenancy                                      | Org A cannot access Org B                          | PASSED      |
| 3   | Authentication                                          | Protected-route and API tests                      | PASSED      |
| 4   | RBAC                                                    | Privilege-escalation tests                         | PASSED      |
| 5   | Audit + events + jobs                                   | Reliable async execution tests                     | PASSED      |
| 6   | Billing + entitlements                                  | Limits cannot be bypassed from the frontend        | PASSED      |
| 7   | Payments (provider abstraction, Tap adapter, webhooks)  | Payment state cannot be forged                     | PASSED      |
| 8   | CRM                                                     | CRM E2E + tenant isolation                         | PASSED      |
| 9   | Activity timeline                                       | Cross-module-ready architecture                    | PASSED      |
| 10  | Communications (inbox, email/WhatsApp/SMS architecture) | Normalized providers + isolation                   | PASSED      |
| 11  | Calendar                                                | Double-booking concurrency tests                   | PASSED      |
| 12  | Forms                                                   | Spam / rate-limit / input validation               | PASSED      |
| 13  | Automation V1                                           | Durable waits, retry, idempotency, loop protection | PASSED      |
| 14  | Commerce                                                | Money precision and payment integrity              | PASSED      |
| 15  | Dashboards + reporting                                  | Permission-aware reports                           | PASSED      |
| 16  | Files + notifications                                   | Production-grade shared services                   | PASSED      |
| 17  | Public API + webhooks                                   | API-key isolation and signature tests              | NOT_STARTED |
| 18  | Integrations framework                                  | Encrypted credentials, state machine               | NOT_STARTED |
| 19  | White label + custom domains                            | Host/domain security                               | NOT_STARTED |
| 20  | AI platform                                             | AI cannot exceed user permissions                  | NOT_STARTED |
| 21  | Projects                                                | —                                                  | NOT_STARTED |
| 22  | Helpdesk                                                | —                                                  | NOT_STARTED |
| 23  | Marketing                                               | —                                                  | NOT_STARTED |
| 24  | Platform admin                                          | Admin separation + audit                           | NOT_STARTED |
| 25  | Security hardening                                      | No open CRITICAL/HIGH                              | NOT_STARTED |
| 26  | Performance                                             | Evidence-based fixes                               | NOT_STARTED |
| 27  | Full test pass                                          | Critical flows covered                             | NOT_STARTED |
| 28  | Deployment                                              | CI/CD, staging/prod templates, runbooks            | NOT_STARTED |
| 29  | Release readiness                                       | No BLOCKERs                                        | NOT_STARTED |
| 30  | Projects/helpdesk/marketing release gates               | Module reliability reviews                         | NOT_STARTED |
| 31  | HR foundation                                           | —                                                  | NOT_STARTED |
| 32  | Inventory / purchasing foundation                       | —                                                  | NOT_STARTED |
| 33  | Accounting design (design before build; double-entry)   | —                                                  | NOT_STARTED |
| 34  | Custom app platform                                     | —                                                  | NOT_STARTED |

## Phase 1 implementation plan (monorepo foundation)

1. Remove the Vercel Express sample (`src/`, `components/`, `public/`, root `tsconfig.json`)
   — it has no business value and conflicts with the target layout (see ADR-002).
2. Root workspace: `package.json` (pnpm 10, Node ≥ 22.12), `pnpm-workspace.yaml`,
   `turbo.json`, `.editorconfig`, `.nvmrc`, `.prettierrc`, `.gitignore`, `.env.example`.
3. `packages/config`: shared `tsconfig` bases (`base`, `node`, `nextjs`), flat ESLint config
   (typescript-eslint strict + type-aware rules), Zod env helpers.
4. `packages/shared`: `AppError` hierarchy, UUIDv7 `newId()`, money (`Money`, minor units,
   currency registry incl. BHD = 3 decimals), pagination helpers, log redaction list — with
   unit tests.
5. `packages/database`: Drizzle + `pg` client factory, `drizzle.config.ts`, migration runner,
   health query, test DB helper. (Schema arrives in Phase 2.)
6. `apps/api`: Fastify 5 app factory (`buildApp`) with env validation, pino logger with
   redaction, request IDs, helmet, CORS allow-list, global rate-limit (Redis store),
   standardized error handler, `/health/live` and `/health/ready` (Postgres + Redis), graceful
   shutdown; tests with `app.inject`.
7. `apps/worker`: BullMQ bootstrap with env validation, Redis connection, health heartbeat,
   graceful shutdown; a `system.ping` queue processor proving the round trip in tests.
8. `apps/web`: Next.js + Tailwind 4 skeleton, `/api/*` rewrite to the API, minimal status page
   (no fake features), lint + typecheck + build.
9. `docker-compose.yml` for Postgres 16 + Redis 7 (local dev), `scripts/` for DB role setup.
10. Vitest workspace config, CI workflow skeleton (`.github/workflows/ci.yml`) running
    `pnpm check` + build with Postgres and Redis services.
11. Gate: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
