# Internal Changelog

Engineering-facing log of what landed per phase. Newest first.

## Phase 6 — Billing and entitlements (2026-10-05)

- Schema: plan catalogue (`plans`, `plan_versions`, `plan_entitlements`, `prices`), tenant
  billing (`billing_customers`, `subscriptions`, `subscription_items`, `entitlement_overrides`,
  `usage_counters`, `usage_records`, `billing_events`) with system-only write policies where
  tenants must not write.
- `@businessos/billing`: entitlement registry, catalogue management, subscriptions (start,
  default plan, change, status, cancel) with billing + domain events, entitlement resolution,
  atomic idempotent quota metering, seat limits; example BHD catalogue seed.
- `users.max` enforced on invitation, join and reactivation; `settings.billing.manage`.
- API: plan catalogue, entitlements/usage, subscription, billing profile endpoints.
- Web: billing page (plan, usage bars, catalogue, billing profile).
- Tooling: `order-migration.mjs` post-generate step; `pnpm db:seed`.

## Phase 5 — Audit, events and jobs (2026-10-05)

- Schema: `audit_logs` (append-only), `outbox_events`, `processed_events`, `job_failures`.
- `@businessos/audit`: `recordAudit` (redacted, size-capped) and paginated `listAuditLogs`.
- `@businessos/events`: typed catalogue, `emitEvent`, `OutboxDispatcher` (SKIP LOCKED claims,
  leases, backoff, failure state), `SubscriberRegistry`, `processOnce`.
- `@businessos/jobs`: job registry with Zod payloads, BullMQ and in-memory queues,
  deterministic job ids, validated processor, final-failure detection.
- Worker: per-queue BullMQ workers, outbox dispatcher loop, `event.deliver` and `email.send`
  handlers, dev email transports (log/file), dead-letter persistence, health endpoint.
- API: events emitted by org/invitation services, audit records for all sensitive actions,
  `audit.read` permission and `/audit-logs` endpoint, queue-backed mailer.
- Web: audit log page; E2E now runs the worker (emails flow through jobs).

## Phase 4 — RBAC (2026-10-05)

- `@businessos/permissions`: catalogue, code-defined system roles, effective permission
  evaluation, escalation guards (`canGrantRole`, `canManageMember`).
- Schema: `roles`, `membership_roles` (composite same-tenant FKs, RESTRICT on assigned roles),
  `invitations.role_id`; backfill migration for existing organizations.
- Organizations: system role seeding on creation, membership resolution with access, custom
  role CRUD, member role/status changes, removal, leave, last-owner invariant with row locking.
- API: permission-aware tenant context, `requirePermission`, organization/settings updates,
  members, roles, invitations management, access + catalogue endpoints.
- Web: members management (invite, roles, suspend/remove, pending invitations), roles editor,
  organization settings; per-page access data.

## Phase 3 — Authentication (2026-10-05)

- `@businessos/auth`: argon2id passwords (policy, rehash-on-login, timing-safe unknown users),
  opaque hashed sessions (absolute + idle expiry), registration with enumeration resistance
  and pre-hijack protection, email verification, password reset/change with session
  revocation, invitations (create/preview/accept/register), organization switching.
- Schema: `sessions`, `auth_tokens`, `invitations` (RLS forced).
- API: `/app/auth/*`, `/app/me/*`, `/app/orgs` (+ tenant-scoped detail/members),
  `/app/invitations/*`; session cookie plugin, CSRF origin check, tenant resolver, Redis rate
  limiter with per-IP and per-account policies, `no-store` for app responses, proxy trust config.
- Web: runtime `/api` proxy, auth pages (login, register, check email, verify, forgot/reset,
  invite), onboarding, tenant app shell with organization switcher, overview and members pages,
  i18n catalogue scaffold (RTL-ready), UI primitives.
- Playwright E2E for registration → organization → members → sign-out, password reset session
  revocation, and open-redirect protection; added to CI.

## Phase 2 — Database + tenancy (2026-10-05)

- Schema: `users`, `organizations`, `memberships`, `organization_settings` with check
  constraints, explicit FK delete rules, and RLS policies (forced) on every table.
- `withTenant` / `withUser` / `withSystem` scoped transactions with branded types.
- `@businessos/organizations`: create organization (unique slug allocation, owner membership,
  extension hooks), list user organizations, resolve membership (404 semantics), update
  organization (allow-listed fields), list members (keyset pagination + search), typed settings.
- `@businessos/testing`: two-tenant world fixture; shared Vitest global setup.
- Fixed an RLS leak found by the new isolation suite (migration 0003).

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
