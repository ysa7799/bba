# Deployment

_Detailed CI/CD, staging and production configuration land in Phase 28._

## Target topology

| Component      | Suggested runtime                             | Notes                                       |
| -------------- | --------------------------------------------- | ------------------------------------------- |
| `apps/web`     | Vercel or container                           | Rewrites `/api/*` to the API's internal URL |
| `apps/api`     | Managed containers (e.g. Fly, ECS, Cloud Run) | Stateless, horizontally scalable            |
| `apps/worker`  | Managed containers                            | Scale by queue depth                        |
| PostgreSQL     | Managed (RDS / Cloud SQL / Neon)              | PITR backups, in-region (GCC)               |
| Redis          | Managed (ElastiCache / Upstash)               | BullMQ + rate limiting; AOF persistence     |
| Object storage | S3-compatible (S3 / R2)                       | Signed URLs                                 |
| Secrets        | Cloud secrets manager                         | Injected as env vars                        |

Data residency for GCC customers is a deployment concern (region selection); the code makes
no assumptions about region.

## Environments

`local` → `test` (CI) → `staging` → `production`, each with separate credentials, databases,
Redis instances and provider accounts. Production env validation refuses development
defaults (e.g. missing `CREDENTIALS_ENCRYPTION_KEYS`, `COOKIE_SECURE=false`).

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

## Proxies and client IPs

- `apps/web` proxies `/api/*` to `API_INTERNAL_URL` at runtime. Keep the API private (only
  reachable from the web tier and trusted load balancers) except for provider callbacks:
  route `/webhooks/*` from the public load balancer straight to the API and set
  `API_PUBLIC_URL` to that public origin. The web proxy forwards only an allow-list of headers
  (no provider signature headers), so webhooks must not go through it. Twilio signs the exact
  URL it calls: the scheme and host the API derives from `API_PUBLIC_URL` must match.
- Set `TRUST_PROXY` on the API to the web tier's address range (or hop count) so per-IP rate
  limits use real client IPs; set `TRUST_PROXY_HEADERS=true` on the web app only when its own
  load balancer overwrites `X-Forwarded-For`.

## Communications configuration (Phase 10)

| Variable                        | Service      | Notes                                                                                            |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `CREDENTIALS_ENCRYPTION_KEYS`   | API + worker | `id:base64(32 bytes)[,id:key…]`; first key encrypts. Required in production. Same value on both. |
| `API_PUBLIC_URL`                | API + worker | Public HTTPS origin for webhook URLs (`https://` required in production).                        |
| `COMMUNICATIONS_FAKE_PROVIDERS` | API + worker | Development/test only; refused in production.                                                    |
| `EMAIL_TRANSPORT=postmark`      | worker       | Platform transactional email; with `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM`.                     |

Generate a key with `node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`.
To rotate, prepend a new key (`k2:…,k1:…`), deploy, then re-save channel credentials before
removing the old key. Losing every key makes stored channel credentials unrecoverable (tenants
re-enter them); keys belong in the secrets manager, never in the repository.

## Migrations in deployment

Migrations run as a separate release step with the owner role before new code is rolled out.
Destructive steps are never run automatically; see `DATABASE.md`.
