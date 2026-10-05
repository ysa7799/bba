# Internal Changelog

Engineering-facing log of what landed per phase. Newest first.

## Phase 1 — Monorepo foundation (2026-10-05)

- Replaced the Express sample with a pnpm/Turborepo monorepo: `apps/{web,api,worker}`,
  `packages/{config,shared,database}`.
- Fastify API foundation (env validation, logging with redaction, request ids, helmet, CORS,
  rate limiting, error envelope, health endpoints), BullMQ worker bootstrap, Next.js skeleton.
- Money/ID/pagination primitives with tests; RLS helper functions migration.
- docker-compose for local deps, DB role setup script, CI workflow.

## Phase 0 — Repository audit (2026-10-05)

- Audited the repository (Express sample only) and recorded the decision to replace it.
- Added CLAUDE.md engineering guide and the docs set under `docs/`.
- Defined the Phase 1 implementation plan.
