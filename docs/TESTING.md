# Testing

## Layers

| Layer                                             | Tool       | Location                                 | Needs            |
| ------------------------------------------------- | ---------- | ---------------------------------------- | ---------------- |
| Unit (domain rules, money, permissions)           | Vitest     | `packages/*/src/**/*.test.ts`            | nothing          |
| Integration (DB, services, HTTP via `app.inject`) | Vitest     | `apps/api/test/**`, `packages/*/test/**` | Postgres + Redis |
| Security (tenant isolation, RBAC escalation)      | Vitest     | `apps/api/test/security/**`              | Postgres + Redis |
| E2E (critical user flows)                         | Playwright | `apps/web/e2e/**`                        | full stack       |

## Fixtures

`createTestWorld()` (Phase 2–4) builds:

- **Organization A** with Owner, Admin, Manager, Sales User, Restricted User
- **Organization B** with Owner, Admin

Each test file creates its own world with unique emails/slugs, so files run in parallel without
truncation. Tests connect as the runtime DB role so RLS is always active. Never flush or
truncate shared stores (Postgres, Redis) from a test: files run in parallel. API test contexts
get a unique Redis key prefix.

Turborepo caches test/lint/typecheck results keyed on package sources (ADR-031); for a gate
run before a checkpoint use `pnpm exec turbo run lint typecheck test build --force`.

## Tenant-isolation suite (required per tenant resource)

Organization A cannot: read, list, search, update, delete, or reference Organization B's
records, nor discover them with guessed IDs (must get 404, never 403 or data).

## Definition of done (per phase)

Functionality exists · typecheck passes · lint passes · relevant tests pass · build succeeds ·
migrations valid · tenant isolation reviewed · permissions reviewed · error handling exists ·
loading/empty/error UI states exist where relevant · docs updated · no silent major TODOs.

## Running

```bash
pnpm test                                 # everything (Postgres + Redis required)
pnpm --filter @businessos/shared test     # one package
pnpm --filter @businessos/web e2e         # Playwright (stack must be running)
```

Test environment variables come from `.env.test` (committed, contains no secrets — only
local service URLs).
