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

## ADR-020 — Events from services, audit from the request layer

Domain services emit domain events inside their transactions (any caller — API, worker,
workflow — produces the same events). Audit records need request context (actor, IP, request id)
and are written by the API handler (or the auth service, which owns its transactions) inside
the same transaction as the change.

## ADR-021 — Auth emails are jobs, enqueued after commit

Auth emails are rendered and delivered by the worker (`email.send`) so delivery gets retries
and dead-letter visibility. They are enqueued after the auth transaction commits rather than
through the outbox, so token-bearing links are never persisted in Postgres in plaintext. A lost
enqueue (Redis down) is recoverable by the user (resend / request again).

## ADR-022 — Polling outbox dispatcher

The dispatcher polls (500 ms idle, continuous while backlogged) instead of using LISTEN/NOTIFY.
It is simple, works through connection poolers, and latency is acceptable. LISTEN/NOTIFY can be
added as a wake-up hint later without changing semantics.

## ADR-023 — Entitlements are data; billing state is system-written

Plans, versions, prices and entitlement values are rows; code references entitlement keys from a
registry with typed kinds and a restrictive fallback. Tenant scope may read but not write
subscription state (RLS), so a tenant-side bug cannot upgrade an organization.

## ADR-024 — Monthly quotas in the organization's timezone

Quota periods are calendar months in the organization's IANA timezone (stored as the local
`YYYY-MM-01`), matching how GCC businesses think about monthly allowances. Subscription-period
aligned quotas can be added later per key if needed.

## ADR-025 — Provider-agnostic payments with server-side verification

Payments go through a `PaymentProvider` port with declared capabilities; Tap is the first
adapter and the commerce/billing domains never see Tap-specific data. Webhooks and return URLs
are treated as hints that trigger `syncPayment`, which re-fetches the authoritative state. This
also limits the blast radius if a provider's webhook signature scheme changes.

## ADR-026 — Renewals by checkout until recurring charging lands

BENEFIT and Apple Pay do not support merchant-initiated recurring charges. Until saved-card
recurring billing is implemented for card payments, every period is paid through a checkout;
lapsed paid periods go `past_due` (grace, still entitled) and then `paused`.

## ADR-027 — CRM records are soft-deleted; links use NO ACTION foreign keys

Contacts, companies, deals, tasks and notes are soft-deleted (`deleted_at`) so audit trails,
the future timeline and accidental bulk deletes stay recoverable; partial unique indexes
ignore deleted rows (an email can be reused after deletion). Same-tenant links between CRM
records use composite foreign keys with `NO ACTION` rather than `RESTRICT`: when an
organization is deleted both sides cascade in one statement, and `NO ACTION` checks at the end
of the statement where `RESTRICT` would fail mid-cascade. Retention/purge arrives with data
lifecycle work (Phase 25–26).

## ADR-028 — Custom field values in JSONB keyed by field id

Custom fields are tenant-defined, so their values cannot be columns. They are stored as a
`custom_fields jsonb` map keyed by the field definition's id (stable even if a field is
archived and a new one reuses its key), validated on write against the definition's type, and
exposed by key in the API. A `jsonb_path_ops` GIN index serves equality filters
(`custom_fields @> …`). Typed projections for reporting can be derived later (Phase 15) without
changing the write model. This is a deliberate exception to "no JSONB for filterable fields".

## ADR-029 — PostgreSQL search for the CRM

Search uses generated `tsvector` columns with the `simple` configuration (no stemming, so
Arabic and English names both work) and prefix queries built only from sanitized terms, plus
digit matching for phone numbers and prefix matching for emails/domains (the text parser keeps
an email as one token). All search goes through `searchCondition`, the seam for a dedicated
engine later. Global search only queries record types the caller can read.

## ADR-030 — Imports and exports are staged in Postgres until file storage exists

CSV imports are uploaded as JSON text, parsed and staged row by row (`crm_import_rows`), then
processed by the worker in resumable batches with a savepoint per row, so a crash or a bad row
never loses progress or aborts the import. Export files are generated by the worker and held in
`crm_exports.content` for 24 hours, downloadable only by their creator. Both move to object
storage when the files service lands (Phase 16); staging rows are purged 30 days after an
import finishes.

## ADR-031 — Turborepo cache keys include internal package sources

Internal packages are source-only (no build step) and the package graph has a dev-dependency
cycle (`testing` ↔ `organizations`), so `^` task dependencies cannot propagate changes. Package
sources, migrations, manifests and shared config are listed in `globalDependencies`: any change
to them invalidates every cached task. Coarser than per-package hashing, but never stale.

## ADR-032 — The timeline is a projection of domain events with per-row visibility

Modules do not write to the timeline directly; the `timeline` subscriber projects their domain
events (plus manually logged calls/meetings/messages) into `activities`, so communications,
calendar, commerce and helpdesk join the timeline by emitting events and registering
projectors. Projection runs in the event's tenant transaction (not system scope) and is
idempotent by source event. Each row stores the permission required to see it and the API
returns only the metadata keys its type declares, so a shared timeline never shows more than
the viewer could open elsewhere. Summaries are snapshots written at projection time, keeping
history readable after renames and deletions.

## ADR-033 — Tenants bring their own messaging provider accounts

Each organization connects its own Postmark server, WhatsApp Business number or Twilio account
as a `channel_connection`. There is no shared platform sender for tenant conversations: the
tenant owns the sender identity, the provider relationship (approvals, templates, costs) and
its deliverability. Credentials are sealed with a platform key ring (`SecretBox`, AES-256-GCM,
versioned key ids, associated data binding each ciphertext to its organization and
connection) and are write-only through the API. The platform's own transactional email
(verification, invitations) stays separate (`EMAIL_TRANSPORT`). Usage is still metered per
channel through entitlements (`email/whatsapp/sms.monthly_limit`).

## ADR-034 — Webhooks are routed by a per-connection URL token, then verified per provider

Providers sign callbacks with a secret that belongs to the tenant's account (app secret, auth
token, basic-auth pair), so the connection must be known before the signature can be checked,
and many payloads do not carry a reliable account identifier. Each connection therefore gets
a random 256-bit token in its webhook path; only its SHA-256 hash is stored (lookup without
keeping the secret), it is masked in logs and can be rotated. The token only selects the
connection — authenticity always comes from the provider signature verified with that
connection's credentials. Unknown tokens and bad signatures are rejected before any parsing
or storage; accepted payloads are deduplicated by provider id and processed in the
connection's tenant.

## ADR-035 — Outbound messages are queued, then delivered by a job

Sending a reply stores the message as `queued` (with quota consumption and WhatsApp-window
checks) in the request transaction and enqueues `communications.send` with a deterministic
job id. The job claims the message, calls the provider and records the result; retryable
provider failures retry with backoff and only the final attempt marks the message failed.
Agents never wait on a provider, a provider outage never loses a message, and a retried
request or job cannot send twice (claim + idempotent quota key). Status receipts from
webhooks only move a message forward.

## ADR-036 — The database prevents double booking (exclusion constraint on busy blocks)

A booking writes one `calendar_busy_blocks` row per host calendar covering the meeting plus its
buffers, under `EXCLUDE USING gist (calendar_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`.
Availability is still checked first (working hours, notice, existing bookings, external busy
times), but only the constraint is race-free: of two concurrent bookings for overlapping time
exactly one commits, the other gets SQLSTATE `23P01` and becomes a 409 (round robin tries the
next free host inside a savepoint). Storing buffered ranges means both bookings' buffers are
respected with one rule. Team bookings hold every host's calendar in one transaction, so they
and individual bookings on a shared host can never overlap. Rejected: advisory locks or
`SELECT … FOR UPDATE` on calendars (correct only if every write path remembers to lock) and
serializable transactions (retry storms under load, no guarantee for raw writes).

## ADR-037 — Availability is computed on demand; no stored slots

Slots are derived per request from weekly rules, date overrides, busy blocks and external busy
times (≤ 31 days per request), in each calendar's IANA zone with DST-safe conversion. Start times
step from the start of each working block (09:00, 09:30…), never from the request window, so
"now" or a mid-block window cannot shift the grid. No slot table to keep in sync with rule
edits, bookings, cancellations and external calendars; caching can be added later per type
and day if measurements require it.

## ADR-038 — Rescheduling is in place; invitees manage bookings with per-email tokens

A reschedule moves the same appointment (its busy blocks are replaced inside a savepoint, so a
taken time leaves it untouched) instead of cancelling and re-creating it: history, contact
links and external events stay attached and `appointment.rescheduled` carries both times.
Invitees have no account: each confirmation, reschedule and reminder email carries its own
256-bit manage token (only a SHA-256 hash is stored, tokens expire 30 days after the
appointment, URLs are masked in logs). Reminders go out 24 hours before the start unless the
booking was made or moved less than 12 hours before it; that decision is stored at booking
time (`reminder_sent_at`), and each reminder is claimed before sending so overlapping runs
cannot send twice.
