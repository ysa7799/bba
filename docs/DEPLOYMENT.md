# Deployment

_Detailed CI/CD, staging and production configuration land in Phase 28._

## Target topology

| Component | Suggested runtime | Notes |
| --- | --- | --- |
| `apps/web` | Vercel or container | Rewrites `/api/*` to the API's internal URL |
| `apps/api` | Managed containers (e.g. Fly, ECS, Cloud Run) | Stateless, horizontally scalable |
| `apps/worker` | Managed containers | Scale by queue depth |
| PostgreSQL | Managed (RDS / Cloud SQL / Neon) | PITR backups, in-region (GCC) |
| Redis | Managed (ElastiCache / Upstash) | BullMQ + rate limiting; AOF persistence |
| Object storage | S3-compatible (S3 / R2) | Signed URLs |
| Secrets | Cloud secrets manager | Injected as env vars |

Data residency for GCC customers is a deployment concern (region selection); the code makes
no assumptions about region.

## Environments

`local` → `test` (CI) → `staging` → `production`, each with separate credentials, databases,
Redis instances and provider accounts. Production env validation refuses development
defaults (e.g. missing `ENCRYPTION_KEY`, `COOKIE_SECURE=false`).

## Local development

```bash
cp .env.example .env
pnpm install
pnpm dev:deps        # docker compose up -d postgres redis
pnpm db:setup        # create runtime role + test DB (idempotent)
pnpm db:migrate
pnpm dev
```

Without Docker, point `DATABASE_URL`/`REDIS_URL` at locally installed services.

## Migrations in deployment

Migrations run as a separate release step with the owner role before new code is rolled out.
Destructive steps are never run automatically; see `DATABASE.md`.
