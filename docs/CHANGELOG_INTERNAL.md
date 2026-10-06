# Internal Changelog

Engineering-facing log of what landed per phase. Newest first.

## Phase 18 — Integrations framework (2026-10-06)

- Schema: `integration_accounts`, `integration_oauth_states`; `calendar_connections.integration_account_id`
  (migrations 0035–0036, FORCE RLS).
- `@businessos/integrations`: OAuth providers (Google, Microsoft 365, development fake) with
  PKCE, authorization start/complete, sealed tokens, refresh with per-account locking and the
  connection state machine, disconnection with revocation, maintenance.
- Calendar: connections can use a connected account (`AccessTokenSource`); tokens are fetched
  before every provider call; disconnected accounts stop their calendars.
- Permission `integrations.manage`; audit actions `integration.connected/disconnected`; job
  `integrations.maintenance` (every 10 minutes); env for OAuth clients and the fake provider.
- API: `/app/orgs/:orgId/integrations` (providers, accounts, start, disconnect) and
  `/app/oauth/complete`.
- Web: "Connect with …" on calendar settings, `/oauth/callback`, development consent page,
  Connected accounts page; E2E.

## Phase 17 — Public API + webhooks (2026-10-06)

- Schema: `api_keys`, `api_idempotency_keys`, `webhook_endpoints`, `webhook_deliveries`
  (migrations 0033–0034, FORCE RLS, composite same-tenant FKs).
- `@businessos/safe-http`: the SSRF-guarded HTTP client moved out of automation; exact-body
  posts and an overall deadline.
- `@businessos/api-keys`: key issuance (hash only, shown once), scopes bounded by the creator
  now, authentication, revocation, expiry, idempotency records.
- `@businessos/webhooks`: endpoints (encrypted secrets, rotation with overlap), public event
  catalogue and envelope, HMAC signing and verification, delivery fan-out subscriber, attempts
  with retries and auto-disable, delivery log, maintenance.
- Permission `api.manage`; audit actions `api_key.created/revoked`,
  `webhook.created/updated/deleted/secret_rotated`; CRM actor `api_key`.
- API: `/api/v1` (me, contacts, companies, deals, tasks, invoices) with per-key, per-org and
  failed-auth rate limits and `Idempotency-Key`; `/app/orgs/:orgId/developers` management;
  env `WEBHOOKS_ALLOW_PRIVATE_NETWORK` (development only).
- Worker: `webhooks` queue, `webhook.deliver` and `developers.maintenance` jobs, `webhooks`
  subscriber.
- Web: "API & webhooks" page (keys and endpoints, secrets shown once), endpoint page (test
  event, on/off, edit, rotate, delete, delivery log with payloads and resend); E2E.

## Phase 16 — Files + notifications (2026-10-05)

- Schema: `files`, `notifications`, `notification_preferences` (migrations 0030–0032; owner-only
  RLS for notifications and preferences; retention index).
- `@businessos/files`: `FileStorage` port (S3 SigV4, local, memory), byte-based type detection
  with an allow-list, safe names with type-matched extensions, attachments to contacts,
  companies and deals, `storage.bytes` quota reserved under an organization lock, SHA-256
  integrity checks, `files.maintenance` job.
- `@businessos/notifications`: catalogue of nine types, event builders, `notifications`
  subscriber with delivery re-checks, inbox (list, unread count, mark read/all), channel
  preferences, `notifications.maintenance` retention job; worker email template
  `notification`.
- API: `/app/orgs/:orgId/files` (list, raw upload, download, delete; audited `files.uploaded`,
  `files.deleted`; rate limit `fileUploadUser`), `/app/orgs/:orgId/notifications`; storage usage
  in billing entitlements; env `FILES_STORAGE`, `FILES_LOCAL_DIR`, `S3_*`.
- Web: attachments panel on contact, company and deal pages; notification bell with unread
  count in the header; notifications page (all/unread, mark read, show more, preferences);
  file storage on the billing page; the proxy forwards download safety headers and allows
  10 MB uploads; E2E.

## Phase 15 — Dashboards + reporting (2026-10-05)

- `@businessos/reporting`: periods in the organization time zone (day / ISO week / month,
  ≤ 366 days), exact per-currency money, server-computed bar scales; reports
  `sales_pipeline`, `revenue`, `contacts`, `tasks`, `conversations`, `appointments`, `forms`,
  `automation`; dashboard (this month); CSV with formula escaping.
- Permission `reports.read` (owner, admin, manager, member); each report also needs its
  module's read permission. Audit action `reports.exported`.
- Migration 0029: per-period reporting indexes.
- API: `/app/orgs/:orgId/reports` (list, dashboard, report, CSV export); rate limits
  `reportRunUser`, `reportExportUser`.
- Web: dashboard on the overview, Reports page (tabs, period form, stat tiles, accessible bar
  charts with tooltips and data tables, breakdown tables, CSV download), "Reports" nav link;
  the app's content column now fills wide screens; E2E.

## Phase 14 — Commerce (2026-10-05)

- Schema: `commerce_settings`, `commerce_tax_rates`, `commerce_products`,
  `commerce_product_prices`, `commerce_quotes`, `commerce_quote_items`, `commerce_invoices`,
  `commerce_invoice_items`, `commerce_payment_connections`, `commerce_checkouts`,
  `commerce_invoice_payments`, `commerce_refunds` (migrations 0027–0028).
- `@businessos/commerce`: exact commercial arithmetic (minor units, per-line half-up rounding,
  tax snapshots), catalogue, quotes (send, customer accept/decline, convert), invoices (drafts,
  gapless numbering on issue, customer links, void, overdue), payment connections (sealed
  credentials, Tap/fake adapters per organization), online checkout with server-side
  verification, commerce webhooks, manual payments, refunds, timeline projectors.
- `@businessos/payments`: platform subscription webhooks and sync ignore invoice payments.
- Permissions `commerce.invoice.read/create/update`, `commerce.catalog.manage`,
  `commerce.payment.refund`, `commerce.settings.manage`; events `quote.sent/accepted/declined`,
  `invoice.created/sent/paid/overdue/voided`; audit actions `commerce.*`; activity types
  `quote.sent/accepted/declined`, `invoice.sent/paid`; job `commerce.maintenance`; email
  templates `quote_sent`, `invoice_sent`; automation triggers `invoice.created`, `invoice.paid`.
- API: `/app/orgs/:orgId/commerce/*`, `/public/commerce/*` (invoice and quote links masked in
  logs; rate limits `commerceDocumentIp`, `commerceCheckoutIp`, `commerceCheckoutDocument`,
  `commerceRespondIp`, `commerceVerifyOrg`, `commerceRefundOrg`), `/webhooks/commerce/:connectionId`
  (`commerceWebhookConnection`); env `COMMERCE_FAKE_PAYMENTS` (refused in production).
- Worker: `commerce.maintenance` hourly; quote/invoice timeline projection.
- Web: Quotes, Invoices (editor, detail, payments, refunds, print/PDF view), Products,
  Invoicing setup (tax rates, numbering, payment provider); customer pages `/i/<token>` (pay
  online) and `/q/<token>` (accept/decline); dev fake checkout; "New invoice" on contacts; E2E.

## Phase 13 — Automation V1 (2026-10-05)

- Schema: `automation_workflows`, `automation_workflow_versions`, `automation_nodes`,
  `automation_edges`, `automation_runs`, `automation_run_steps`, `automation_run_logs`
  (migrations 0025–0026).
- `@businessos/automation`: triggers, actions, conditions, templates, definition validation,
  workflow lifecycle, run engine (durable waits, retries, timeouts, manual retry/cancel),
  loop protection, SSRF-hardened HTTP client, event subscriber.
- Permissions `automation.workflow.read/manage`; events `workflow.started/completed/failed`;
  audit actions `automation.workflow.*`, `automation.run.*`; jobs `automation.run`,
  `automation.resume`; queue `automation`; CRM actor type `workflow`.
- API: `/app/orgs/:orgId/automation/*`, `/webhooks/automation/:token` (rate limits
  `automationWebhookIp`, `automationWebhookToken`; token masked in logs); env
  `AUTOMATION_ALLOW_PRIVATE_NETWORK`.
- Worker: automation subscriber, `automation.run` and `automation.resume` (every minute).
- Web: Workflows list, builder and run history; E2E (with a plan that includes automation).
- Fixes: workflow job ids, a fixed-date UUIDv7 test.

## Phase 12 — Forms (2026-10-05)

- Schema: `forms`, `form_versions`, `form_fields`, `form_submissions` (migrations 0023–0024).
- `@businessos/forms`: fields and answer validation, settings, CRM mapping allow-list,
  versioned builder services with `forms.max`, public resolution, submissions (render-token
  idempotency, spam quarantine, CRM processing with savepoints and notes, release), timeline
  projector, `CaptchaVerifier` with Turnstile and fake adapters.
- Permissions `forms.read/manage`, `forms.submission.read`; event `form.submitted`; audit
  actions `forms.form.*`, `forms.submission.released`; entitlement `forms.max` (seed: 3 / 25 /
  unlimited); timeline category `form` (and the missing `appointment` filter in the web app).
- API: `/app/orgs/:orgId/forms/*`, public `/public/forms/*` with Redis render tokens and rate
  limits `formReadIp`, `formSubmitIp`, `formSubmitForm`; env `TURNSTILE_SITE_KEY`,
  `TURNSTILE_SECRET_KEY`, `FORMS_FAKE_CAPTCHA`.
- Worker: forms timeline projector registered.
- Web: Forms list, builder, submissions, public `/f/<slug>` and `/f/<slug>/embed`; request proxy
  (`src/proxy.ts`) for per-form `frame-ancestors`; global `X-Frame-Options: DENY` now also
  `frame-ancestors 'none'`; E2E.
- Testing: shared test plan republished when entitlements are added; E2E visitors get distinct
  client IPs.

## Phase 11 — Calendar & booking (2026-10-05)

- Schema: `calendars`, `calendar_availability_rules`, `calendar_availability_exceptions`,
  `appointment_types`, `appointment_type_hosts`, `booking_pages`, `booking_page_types`,
  `appointments`, `appointment_manage_tokens`, `appointment_participants`,
  `calendar_busy_blocks` (exclusion constraint, `btree_gist`), `calendar_connections`,
  `appointment_external_events` (migrations 0021–0022).
- `@businessos/calendar`: DST-safe zone arithmetic, availability engine, scheduling modes
  (one host, round robin, team), calendars/availability, appointment types, booking pages,
  concurrency-safe booking, cancel/reschedule/status, invitee manage links, reminders,
  external calendar sync, timeline projectors; Google Calendar and Microsoft 365 adapters and
  a fake.
- Permissions `calendar.appointment.read/manage`, `calendar.manage`; events
  `appointment.booked/rescheduled/cancelled/status_changed`; audit actions `calendar.*`; jobs
  `calendar.reminders` (scheduled) and `calendar.sync`; timeline category `appointment`.
- API: `/app/orgs/:orgId/calendar/*`, public `/public/booking/*` (rate limits
  `booking*`); manage tokens masked in logs; `no-store` on public responses.
- Worker: reminder and sync handlers, appointment email templates, `APP_URL`.
- Web: Calendar (week agenda, book/reschedule/cancel/complete), Scheduling setup (availability,
  overrides, calendars, types, booking pages, connections), public `/book/<slug>` and
  `/book/manage/<token>`, appointments on contact pages; E2E.
- Tooling: bundle verifier no longer mistakes prose in string literals for imports;
  transactional queries no longer run concurrently on one connection (calendar, billing).

## Phase 10 — Communications (2026-10-05)

- Schema: `channel_connections`, `conversations`, `conversation_participants`,
  `conversation_tags`, `messages`, `message_attachments`, `channel_templates`,
  `communication_webhook_events` (migrations 0019–0020).
- `@businessos/shared`: `SecretBox` (AES-256-GCM key ring), `redactUrlForLog`.
- `@businessos/communications`: `ChannelProvider` port; Postmark, WhatsApp Cloud API, Twilio
  and fake adapters; connections (sealed credentials, webhook tokens), conversations
  (inbox listing, assignment, status, tags, unread), messages (queue, deliver, notes,
  templates, 24-hour window), webhook pipeline, timeline projectors.
- Permissions `communications.read/send/assign/manage`; events `conversation.*`,
  `message.*`; audit actions `communications.channel.*`, `communications.template.registered`;
  `messages` job queue with `communications.send`.
- API: `/app/orgs/:orgId/communications/*`, `/webhooks/communications/:provider/:token`,
  dev simulator; env `CREDENTIALS_ENCRYPTION_KEYS`, `COMMUNICATIONS_FAKE_PROVIDERS`;
  request logs mask webhook tokens.
- Worker: `communications.send` handler, communications timeline projectors, Postmark
  transactional email transport.
- Web: Inbox (filters, thread, composer with internal notes and WhatsApp templates,
  assignment/status/tags), Channels settings (connect, write-only credentials, one-time
  webhook URL, rotate, disconnect, templates, dev simulator), "Message" on contacts; E2E.

## Phase 9 — Activity timeline (2026-10-05)

- Schema: `activities` (migrations 0017–0018).
- `@businessos/activities`: registry, record/list/delete, projection subscriber.
- CRM: timeline projectors, `note.created` / `activity.logged` events, manual activity
  logging, record timelines; permissions `crm.activity.log`, `crm.activity.manage`; audit
  action `crm.activity.deleted`.
- API: `/crm/{contacts,companies,deals}/:id/timeline`, `/crm/activities` (GET/POST/DELETE).
- Worker: `timeline` subscriber registered. Web: Activity panel with log dialog; E2E.

## Phase 8 — CRM (2026-10-05)

- Schema: `crm_contacts`, `crm_companies`, `crm_contact_companies`, `crm_pipelines`,
  `crm_pipeline_stages`, `crm_deals`, `crm_tasks`, `crm_notes`, `crm_tags`,
  `crm_contact_tags`, `crm_company_tags`, `crm_deal_tags`, `crm_custom_fields`,
  `crm_imports`, `crm_import_rows`, `crm_exports` (migrations 0015–0016).
- `@businessos/crm`: services for every CRM record type, custom fields, tags, search, keyset
  listing, CSV parser/writer, imports, exports, global CRM search, maintenance.
- Permissions `crm.*` (21), events (`contact.*`, `company.*`, `deal.*`, `task.*`), audit
  actions `crm.*`, `data` job queue with `crm.import`, `crm.export`, `crm.maintenance`.
- API: `/app/orgs/:orgId/crm/*` (contacts, companies, deals, board, pipelines/stages, tasks,
  notes, tags, custom fields, assignees, search, bulk, imports, exports).
- Web: CRM navigation and pages, CRM components, proxy body limit raised only for CSV uploads,
  `useMutation` can skip the refresh when navigating away.
- Tooling: Turborepo `globalDependencies` include package sources; web unit tests stub
  `server-only`; `*.rdb` ignored.

## Phase 7 — Payments (2026-10-05)

- Schema: `payments`, `checkout_sessions`, `payment_webhook_events` (tenant read-only / system).
- `@businessos/payments`: provider port with capabilities and normalized types, forward-only
  status machine, registry, Tap adapter (charges, retrieval, refunds, `hashstring` webhooks,
  CONFIGURATION_REQUIRED without keys), fake provider, checkout creation, `syncPayment`,
  webhook handling, subscription activation and maintenance.
- API: payments config, checkout create/status/verify, payment history, raw-body webhook
  endpoint, dev-only fake completion route; env safety for providers.
- Worker: hourly `billing.maintenance` scheduler.
- Web: subscribe buttons (only when a provider is ready), checkout return page with server
  verification polling, dev fake hosted page; E2E subscription flow.
- Tooling: `scripts/db/generate.mjs` forwards flags to drizzle-kit.

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
