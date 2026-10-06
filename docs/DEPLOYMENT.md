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

## Scheduling configuration (Phase 11)

- Migration 0022 runs `CREATE EXTENSION IF NOT EXISTS btree_gist` (trusted: the database owner
  can create it on PostgreSQL 13+; managed providers ship it). The double-booking constraint
  depends on it.
- Worker: `APP_URL` (public web URL, `https://` in production) for links in reminder emails; the
  worker schedules `calendar.reminders` every 5 minutes.
- `CALENDAR_FAKE_PROVIDERS` (API + worker) enables the in-memory calendar provider for
  development and tests only; refused in production.
- Public booking pages are served by the web app at `/book/<slug>`; their API routes live under
  `/public/booking/*` behind the same proxy (rate limited per client IP, so keep
  `TRUST_PROXY` / `TRUST_PROXY_HEADERS` correct).

## Forms configuration (Phase 12)

- Public forms are served by the web app at `/f/<slug>` and `/f/<slug>/embed`; their API
  routes live under `/public/forms/*` (rate limited per client IP and per form — keep
  `TRUST_PROXY` / `TRUST_PROXY_HEADERS` correct).
- The web app's request proxy (`src/proxy.ts`) calls the API for each embed request to set
  `Content-Security-Policy: frame-ancestors …`; it needs `API_INTERNAL_URL` like the rest of
  the web server. All other pages send `X-Frame-Options: DENY`.
- Render tokens live in Redis for 24 hours under `REDIS_KEY_PREFIX`; Redis is required to load
  and submit forms.
- Captcha (optional): `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` on the API (secret in the
  secrets manager). `FORMS_FAKE_CAPTCHA` is for development/tests and refused in production.

## Automation configuration (Phase 13)

- The worker consumes a dedicated `automation` queue (workflow runs) and schedules
  `automation.resume` every minute; run continuation does not depend on Redis keeping delayed
  jobs (the database is the source of truth).
- `AUTOMATION_ALLOW_PRIVATE_NETWORK` (API + worker) lets webhook actions call http:// and
  private addresses for development and tests only; refused in production.
- Inbound workflow webhooks are served by the API at `/webhooks/automation/<token>` under
  `API_PUBLIC_URL`; `API_PUBLIC_URL` and `APP_URL` are also used to refuse workflow calls to
  BusinessOS itself.

## Commerce configuration (Phase 14)

- No new required variables. Organizations connect their own payment provider; storing its
  keys needs `CREDENTIALS_ENCRYPTION_KEYS` (already required in production).
- Provider notifications arrive at `API_PUBLIC_URL/webhooks/commerce/<connectionId>`; customer
  links are `APP_URL/i/<token>` (invoices) and `APP_URL/q/<token>` (quotes).
- The worker schedules `commerce.maintenance` hourly (overdue invoices, expired quotes).
- `COMMERCE_FAKE_PAYMENTS` (API) and `ENABLE_DEV_PAYMENTS` (web) are development/test only;
  the API refuses the former in production.

## Files and notifications configuration (Phase 16)

- `FILES_STORAGE` (`local` | `s3`, API and worker). Production requires `s3` with
  `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and, for non-AWS
  providers, `S3_ENDPOINT` (see `INTEGRATIONS.md`). `FILES_LOCAL_DIR` (default `.data/files`)
  is for development only.
- Uploads are at most 10 MB; reverse proxies in front of the web app must allow request bodies
  of at least 10.1 MB on `/api/app/orgs/*/files`.
- The worker schedules `files.maintenance` (abandoned uploads, deferred object deletions) and
  `notifications.maintenance` (retention) hourly. Notification emails use the existing email
  transport and `APP_URL` for links.

## Public API and webhooks (Phase 17)

- The public API is served by the API process at `API_PUBLIC_URL/api/v1`; expose it publicly
  (it is not proxied by the web app). It needs no new variables.
- Webhook signing secrets use `CREDENTIALS_ENCRYPTION_KEYS` (API and worker).
- The worker consumes the new `webhooks` queue and schedules `developers.maintenance` hourly
  (re-queues lost attempts, prunes deliveries after 30 days and idempotency records after a
  day). Outbound HTTPS to customer endpoints must be allowed from the worker.
- `WEBHOOKS_ALLOW_PRIVATE_NETWORK` (API and worker) lets endpoints use http:// and private
  addresses for local development and tests only; production refuses it.

## Migrations in deployment

Migrations run as a separate release step with the owner role before new code is rolled out.
Destructive steps are never run automatically; see `DATABASE.md`.
