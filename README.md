# BusinessOS

Multi-tenant Business Operating System SaaS — CRM, communications, automation, scheduling,
commerce, projects, helpdesk and more in one account. Built for Bahrain/GCC first.

- Engineering rules: [`CLAUDE.md`](CLAUDE.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Roadmap and status: [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/BUILD_PROGRESS.md`](docs/BUILD_PROGRESS.md)

## Quick start

Requirements: Node 22.12+, pnpm 10, PostgreSQL 16+, Redis 7+ (or Docker).

```bash
cp .env.example .env
pnpm install
pnpm dev:deps        # Postgres + Redis via docker compose (skip if running locally)
pnpm db:setup        # runtime DB role + dev/test databases (idempotent)
pnpm db:migrate
pnpm dev             # web :3000, api :4000, worker
```

## Quality gate

```bash
pnpm check   # format:check, lint, typecheck, test
pnpm build
```

## Layout

```
apps/web       Next.js frontend (UI only)
apps/api       Fastify HTTP API
apps/worker    BullMQ background jobs
packages/*     shared infrastructure and domain services
docs/          architecture, security, roadmap, decisions
```
