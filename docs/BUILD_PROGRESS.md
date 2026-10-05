# Build Progress

## Current Phase

Phase 14 — Commerce

Status: NOT_STARTED

---

## Phase 13 — Automation V1

Status: PASSED

### Completed

- Schema (7 tables, FORCE RLS, composite same-tenant FKs): workflows (draft/active/paused/
  archived, hashed inbound webhook token), versions with trigger, nodes and edges (one way into
  every node), runs (unique per workflow and trigger occurrence, chain depth, resume time,
  deadline), run steps (unique per run and step) and run logs.
- `@businessos/automation`: trigger catalogue (contact created/updated/tagged, form submitted,
  deal created/stage changed, appointment booked, task completed, message received, inbound
  webhook) with filters; tree-shaped definitions validated (no cycles, merges or unreachable
  steps, per-action settings, placeholders); actions (create/update contact, add/remove tag,
  assign owner, create/move deal, create task, send email/SMS/WhatsApp template, call a
  webhook), waits and conditions; templates; workflow lifecycle (draft, publish,
  `automation.workflows.max`, pause/resume, archive, webhook tokens); run engine (start from
  events and webhooks, monthly execution quota, step-per-transaction executor, durable waits,
  retry with backoff, timeouts, manual retry and cancel); loop protection; SSRF-hardened HTTP
  client.
- Catalogue: permissions `automation.workflow.read/manage`; events `workflow.started/
completed/failed`; audit actions `automation.*`; jobs `automation.run` (new `automation`
  queue) and `automation.resume`; CRM actor type `workflow`.
- API: `/app/orgs/:orgId/automation/*` (audited), inbound `/webhooks/automation/:token`
  (rate limited, masked in logs); env `AUTOMATION_ALLOW_PRIVATE_NETWORK`.
- Worker: automation subscriber, run and resume handlers, one-minute resume schedule.
- Web: Workflows list, builder (trigger and filters, steps with yes/no branches, every action's
  settings, placeholders, publish/discard/pause/resume/archive, webhook URL shown once), run
  history with steps, logs, retry and cancel.

### Tests

- automation (23): templates and conditions; definition validation (cycles, merges,
  unreachable steps, branches, settings, placeholders, wait limits); trigger filters; SSRF
  guard (address ranges, URL rules, private DNS answers at connect time, own hosts); a run
  with a two-day **durable wait** resumed by the scheduler and a condition branch; runs keep
  their version; **duplicate events** (sequential and 5 concurrent deliveries → 1 run);
  **idempotent steps** (6 concurrent executions → each action once, 1 webhook call);
  **retries** with backoff and a constant idempotency key; failure after the last attempt and
  on permanent errors; manual retry without repeating earlier steps; missing subject and
  **timeouts**; pause/resume and archive; `automation.workflows.max` under concurrency and the
  monthly run quota; **loop protection** (chain depth, self-trigger, hourly cap); inbound
  webhook runs (idempotency key, token rotation); messages queued through the channel;
  **tenant isolation** across every service, references and triggers.
- API (8): permissions; validation and unsafe webhook targets; inbound webhook runs end to end
  with steps and logs; unknown tokens, bad bodies, paused workflows, rotation; retry and
  cancel (audited); cross-tenant 404s; production refuses private networks; tokens never
  logged. Web: tree conversion (2).
- E2E: subscribe to a plan with automation, build and publish a workflow, a new contact gets
  the tag and task from the worker, run history, a webhook-triggered workflow creates a
  contact once per delivery.
- Full suite (uncached): 497 unit/integration + 11 E2E passing.

### Fixed during the phase

- A retried webhook step was claimed while its run stayed "waiting", so its result was
  discarded (found by tests).
- Job ids with `:` would have been refused by the queue (see SECURITY findings); the test
  queue now enforces the production rule.
- Webhook actions could call BusinessOS itself (see SECURITY findings).
- A shared-package test used a fixed timestamp of today; the UUIDv7 generator is monotonic, so
  it started failing once the real clock passed it. It now uses a time relative to now, plus a
  test that ids never go back in time.

### Risks

- The webhook action is not signed yet (signed outbound webhooks arrive in Phase 17).
- Invoice triggers and "create invoice", "send notification" and "AI" steps arrive with
  commerce (14), notifications (16) and AI (20).
- Steps cannot merge after a condition (by design for V1); complex flows repeat steps per
  branch.
- Runs are executed per tenant without per-organization fairness; a very busy organization
  can delay others on the `automation` queue (measure in Phase 26).

### Next

- Phase 14: commerce (products, quotes, invoices, payments, refunds).

---

## Phase 12 — Forms

Status: PASSED

### Completed

- Schema (4 tables, FORCE RLS, composite same-tenant FKs): forms (global public slug,
  active/archived), versions (one draft and one published per form), fields as rows (12
  types), submissions (validated answers, accepted/spam, processing notes, unique render-token
  key per form).
- `@businessos/forms`: field definitions and answer validation/normalization; settings
  (texts, https redirect, CRM behaviour, captcha, embed origins); CRM mapping allow-list with
  custom-field compatibility; create/draft/discard/publish/archive with `forms.max`; public
  resolution; submissions (idempotent, spam quarantine, find-or-create contact that only
  fills empty properties, tags, deal, note, each step in a savepoint with processing notes,
  `form.submitted`); release from spam; listing; timeline projector; spam heuristics and a
  `CaptchaVerifier` port with Turnstile (CONFIGURATION_REQUIRED) and fake adapters.
- Catalogue: permissions `forms.read/manage`, `forms.submission.read`; event `form.submitted`;
  audit actions `forms.form.*`, `forms.submission.released`; entitlement `forms.max`; timeline
  category `form`.
- API: staff routes under `/app/orgs/:orgId/forms` (permission-checked, audited), public
  `/public/forms/*` (render tokens in Redis, per-IP and per-form limits, 64 KB bodies,
  `no-store`, identical answer for spam), env `TURNSTILE_*` and `FORMS_FAKE_CAPTCHA`.
- Worker: form submissions projected onto contact (and deal) timelines.
- Web: Forms list, builder (fields, mapping, options, validation, settings, publish/discard,
  share link and embed code), submissions (received/spam, answers, notes, release), public
  `/f/<slug>` and embeddable `/f/<slug>/embed` (hidden fields prefilled from the link, height
  reported to the embedding page); per-form `frame-ancestors` via the request proxy, every
  other page `X-Frame-Options: DENY`.
- Also fixed: the Phase 11 timeline filter had no Appointments category (and now Forms).

### Tests

- forms (28): field definition rules; normalization of every type, unknown and prototype keys
  ignored, all errors reported per field; settings (redirects and embed origins that could be
  abused are refused); mapping allow-list (protected properties, type compatibility, custom
  options); spam heuristics; Turnstile verification incl. fail-closed; versioning and
  republishing; draft validation incl. foreign tags, pipelines and members; global slugs;
  `forms.max` under concurrency; full CRM processing (contact, owner and lifecycle from
  settings, tags, custom field, deal without value, note, event, timeline); fill-empty policy
  on existing contacts; invalid answers store nothing; spam quarantine and release;
  **5 concurrent submits of one rendered form → 1 submission, 1 contact**; processing notes
  for deleted tags and a full contact quota; old versions accepted, drafts refused; tenant
  isolation across every service.
- API (9): role permissions; privileged fields ignored on create, audit entries; public render
  (no mapping targets or settings exposed) and submission into the CRM, double submit; answer
  validation; forged, missing and other-form render tokens; honeypot and instant submissions
  quarantined with the normal response, release; archived/unpublished forms offline, embed
  policy; cross-tenant 404s and foreign settings refused; **per-IP submit rate limit**;
  captcha required and verified when configured, refused when not.
- Web: embed-policy unit tests (route matching, header injection fails closed).
- E2E: build a form with a choice field and an allowed embed site, publish, embed headers,
  public submission with a validation error then success, submission with labels, new contact
  with the submission on its timeline.
- Full suite (uncached): 463 unit/integration + 10 E2E passing.

### Fixed during the phase

- A full contact quota was reported as "custom fields not saved" (found in phase review);
  now a dedicated note + regression test.
- Some form queries relied on RLS alone (see SECURITY findings).
- The shared test plan predated new entitlements, so fixture organizations fell back to
  default limits; it is republished whenever the catalogue gains keys.
- The E2E suite outgrew the per-IP registration limit (all sign-ups from 127.0.0.1); each test
  now acts as its own visitor through `X-Forwarded-For` instead of relaxing the limit.

### Risks

- File upload fields wait for the files service (Phase 16).
- Notifications to staff on new submissions arrive with the notification system (Phase 16);
  automation on `form.submitted` with Phase 13.
- No CSV export of submissions yet (the CRM export framework can be reused).
- A visitor who knows a customer's email can add missing details (e.g. a phone number) to that
  contact — the deliberate fill-empty policy (ADR-041); nothing is overwritten.
- The inbox E2E logs a harmless "destination stream closed early" from an aborted RSC stream
  (pre-existing, Phase 10).

### Next

- Phase 13: automation V1 (triggers including `form.submitted`, durable waits, retries,
  idempotency, loop protection).

---

## Phase 11 — Calendar & booking

Status: PASSED

### Completed

- Schema (13 tables, FORCE RLS, composite same-tenant FKs): calendars (personal/shared),
  weekly hours and date overrides, appointment types with hosts, booking pages, appointments
  with participants, busy blocks under an **exclusion constraint** (`btree_gist`), invitee
  manage tokens, external calendar connections and mirrored events.
- `@businessos/calendar`: DST-safe time-zone arithmetic; availability engine (working hours,
  overrides, buffers, slot interval, minimum notice, maximum advance); scheduling modes (one
  host, round robin by load, team); concurrency-safe booking for public pages and staff
  (savepoint retries across round-robin hosts); in-place reschedule; cancel; completed/no-show;
  invitee manage links; reminders (24 h, claimed, decided at booking time); external calendar
  sync (create/recreate/remove, idempotent); Google Calendar and Microsoft 365 adapters
  (CONFIGURATION_REQUIRED) and a fake; timeline projectors.
- API: staff routes under `/app/orgs/:orgId/calendar` (permission- and ownership-checked,
  audited configuration), public `/public/booking/*` (rate limited, honeypot, `no-store`,
  times only), confirmation/reschedule/cancellation emails and sync jobs after commit.
- Worker: `calendar.reminders` every 5 minutes, `calendar.sync`, appointment email templates.
- Web: Calendar week agenda with booking, reschedule, cancel, completed/no-show; Scheduling
  setup (my availability, overrides, calendars, appointment types, booking pages, connected
  calendars); public booking flow in the visitor's time zone and invitee manage page;
  upcoming appointments and "Book" on contact pages.

### Tests

- calendar (33): zone conversion incl. DST and half-hour offsets; interval algebra; working
  hours with overrides; slot rules (buffers both sides, notice, advance, end of day); modes and
  round-robin ranking; **concurrency**: 10 simultaneous bookings of one slot → exactly 1;
  overlapping/buffered simultaneous bookings never overlap; round robin assigns different hosts
  and refuses the rest; team vs individual booking on a shared host; raw overlapping insert
  rejected by the constraint; lifecycle (staff override, reschedule conflict leaves the
  appointment unchanged, cancel frees time, status rules, events, keyset paging); manage tokens
  (scope, tamper, expiry); tenant isolation; reminders (once, retry after failure, skip late
  bookings and cancellations, re-due after reschedule); sync (idempotent, outage retry,
  recreate, remove); timeline; Google/Microsoft adapter contracts and error classification.
- API (6): role permissions incl. own-calendar editing; full public flow (honeypot, 409 on a
  taken slot, emails and sync jobs, self-service reschedule/cancel); invitees cannot change
  started appointments or reschedule deactivated types; cross-tenant 404s across every route;
  manage tokens never logged. Worker: templates and production configuration.
- E2E: set up scheduling, book publicly as a visitor, confirmation email link, booking in the
  staff calendar with a new contact, reschedule and cancel from the manage link.
- Full suite (uncached): 424 unit/integration + 9 E2E passing.

### Fixed during the phase

- Start times could follow the request window instead of the working-hours grid (off-grid
  bookable times, grid shifting with "now") — found by tests; regression tests.
- Manage-link tokens would have been logged (see SECURITY findings).
- Concurrent queries on one transaction connection (pg deprecation) in calendar and billing.
- The bundle dependency verifier treated prose in string literals as imports.
- Invitee manage links could cancel or move an appointment that had already started, and move
  one of a deactivated type (found in phase review); regression test.
- The Phase 10 inbox E2E used an ambiguous text locator that could also match a hint; made
  exact (it failed once in the full run).

### Risks

- Live Google/Microsoft connections need OAuth token handling (Phase 18); Zoom meetings too.
- Availability is computed per request (≤ 31 days); heavy public traffic may need caching per
  type and day (measure first, Phase 26).
- Reminders and confirmations are English plain-text emails until the notification system
  (Phase 16); no SMS/WhatsApp reminders yet.
- Recurring appointments and group events (several invitees per slot) are not supported.

### Next

- Phase 12: forms (builder, versions, public form with spam and rate limiting, submissions,
  CRM and custom-field mapping).

---

## Phase 10 — Communications

Status: PASSED

### Completed

- Schema (8 tables, FORCE RLS, composite same-tenant FKs): channel connections, conversations
  (one per connection + counterpart), participants, conversation tags, messages (internal
  notes included), attachment metadata, WhatsApp templates, webhook event log (system only).
- `SecretBox` key ring (AES-256-GCM, versioned keys, associated data per record) for channel
  credentials; `CREDENTIALS_ENCRYPTION_KEYS` required in production for API and worker.
- `@businessos/communications`: `ChannelProvider` port with Postmark (email), WhatsApp Cloud
  API and Twilio (SMS) adapters plus fakes; connections with write-only credentials,
  `configuration_required` state, per-connection webhook token (hash stored, rotatable);
  inbound pipeline (route → verify → normalize → dedupe → contact match/create →
  conversation → message → events → timeline); outbound queue/deliver with WhatsApp
  24-hour window and approved templates, monthly channel quotas (idempotent), retry
  semantics and forward-only delivery statuses; shared inbox (filters, unread, assignment,
  open/closed, tags, internal notes, start from a contact).
- Permissions `communications.read/send/assign/manage`; events `conversation.*`,
  `message.*`; audited channel and template changes; `communications.send` job.
- API routes, provider webhook endpoints (raw body, 404/401 before parsing), development
  simulator (fake providers only, refused in production). Worker delivery handler, timeline
  projectors and Postmark transport for platform email.
- Web: Inbox (list + thread + details, polling refresh, mark-read), Channels settings
  (connect, credentials, webhook URL shown once, rotate, disconnect, templates, simulator),
  "Message" action on contacts.

### Tests

- shared: SecretBox (tamper, wrong record, key rotation), URL log redaction.
- communications (20): provider contracts (Postmark, WhatsApp Cloud, Twilio signatures and
  payload mapping, error classification), sealed credentials and token hashing,
  configuration-required channels, inbound routing/verification/dedupe/unread, contact
  matching, numbers outside known ranges kept, sending + forward-only statuses, 24-hour
  window and templates, retries and final failure, quota without partial messages, tenant
  isolation of conversations/messages/webhooks, timeline projection.
- API (5): channel admin vs member views and cross-tenant 404s, write-only secrets (response
  and audit), signed webhooks only, inbox flow with restricted/member/admin roles, outbound
  start and window refusal, simulator gating, webhook tokens never logged.
- Worker: Postmark transport, `communications.send` handler.
- E2E: connect a channel, simulated inbound, reply delivered by the worker, internal note,
  assign, close, message on the contact timeline.
- Full suite (uncached): 382 unit/integration + 8 E2E passing.

### Fixed during the phase

- HIGH: request logs would have contained webhook routing tokens and WhatsApp verify tokens;
  the API's request serializer now masks them (regression tests).
- Inbound messages from well-formed numbers that phone metadata does not know (≈1% of
  random Bahrain test numbers, and genuinely new ranges) were dropped; they are now kept
  (conversation without a contact). Found as an intermittent test failure; regression test.

### Risks

- Live providers are CONFIGURATION_REQUIRED: payload field names follow public docs and
  must be validated against sandbox accounts.
- Attachments are metadata only until the files service (Phase 16); rich email (HTML) is
  reduced to text.
- The inbox refreshes by polling (15 s); real-time push comes with notifications (Phase 16).
- Conversations without a matching contact cannot yet be linked to a contact from the UI.

### Next

- Phase 11: calendar (availability, booking with double-booking protection, reminders).

---

## Phase 9 — Activity timeline

Status: PASSED

### Completed

- `activities` table (FORCE RLS, composite same-tenant links to contact/company/deal,
  per-row `required_permission`, unique `source_event_id`).
- `@businessos/activities`: type registry (category, default permission, channel, exposed
  metadata keys, manual flag), `recordActivity` (redacted, size-capped, idempotent per source
  event), permission-gated keyset `listActivities`, `deleteLoggedActivity`, and the `timeline`
  event subscriber that projects events inside the event's tenant.
- CRM projectors for contact/company/deal/task/note events with name and value snapshots;
  `note.created` and `activity.logged` events; manual logging of calls, meetings, emails,
  WhatsApp and SMS with links completed from the record graph.
- API: record timelines, organization feed, log and delete activities
  (`crm.activity.log`, `crm.activity.manage`, audited deletes).
- Web: Activity panel on contact, company and deal pages with category tabs, paging and a
  "Log activity" dialog. The worker registers the timeline subscriber.

### Tests

- activities (7): registry integrity, exactly-once projection per event, link requirement and
  summary collapsing, per-row permission gating and metadata allow-list (sensitive keys never
  returned), keyset paging with equal timestamps, RLS isolation and cross-tenant link
  rejection, deletion rules (projected rows immutable, author/moderator, permission and tenant
  checks).
- crm timeline (3): full contact timeline from real outbox events (redelivery adds nothing,
  snapshots, ordering, deal/company views), deal notes hidden without deal access, logged
  calls with completed links, future dates and cross-tenant attempts rejected.
- API (3): projected timeline with role gating and category filter, logging/deleting with
  forged server fields ignored, authorship/moderation and audit, cross-tenant 404s and feed
  isolation.
- E2E: worker-projected history appears on the contact page; a logged call shows and filters.
- Full suite (uncached): 347 unit/integration + 7 E2E passing.

### Risks

- Summaries are English snapshots; localized rendering from type + metadata comes with the
  Arabic catalogue.
- Events emitted before this phase have no activities (no production data yet; a replay tool
  can project old outbox events if ever needed — projection is idempotent).
- Timeline updates arrive asynchronously (outbox poll ≈ 0.5 s).

### Next

- Phase 10: unified communications domain (conversations, messages, channel accounts),
  provider abstraction for email/WhatsApp/SMS with mock adapters and webhook security.

---

## Phase 8 — CRM

Status: PASSED

### Completed

- Schema (16 tables, all with FORCE RLS and composite same-tenant foreign keys): contacts,
  companies, contact↔company links, pipelines, stages, deals, tasks, notes, tags with
  per-entity join tables, custom field definitions, imports (+ staged rows), exports.
- `@businessos/crm`: contacts/companies/deals CRUD with soft delete, E.164 phone
  normalization in the organization's country, typed custom fields (13 types, validated per
  type, keyed by field id, JSONB containment filters), tags, contact↔company links with one
  primary company, pipelines/stages with structural guards, deal board with fractional
  positions and renormalization, won/lost/reopen transitions, tasks with timezone-aware due
  filters, notes (author or moderator), bulk actions, PostgreSQL search (tsvector prefix +
  phone digits + email/domain prefix), keyset pagination for every sort, entitlement limits
  (`crm.contacts.max`, `crm.pipelines.max`), CSV import (staging, mapping suggestions,
  preview, duplicate policy, resumable batches with per-row savepoints and errors) and async
  CSV export (formula-injection escaping, 24 h expiry, creator-only download).
- 21 `crm.*` permissions mapped to system roles; 16 CRM domain events; 15 CRM audit actions.
- API under `/app/orgs/:orgId/crm/*`; worker `data` queue with `crm.import`, `crm.export`
  and hourly `crm.maintenance`.
- Web: contacts, companies, deals board (drag and drop + keyboard-accessible move), tasks,
  record pages with notes/tasks/related records, import & export, CRM settings (pipelines,
  stages, custom fields, tags).

### Tests

- crm package (38): normalization, CSV parsing/escaping round trip, search sanitization,
  mapping suggestions; contacts (normalization, events, identity rule, per-tenant email
  uniqueness, owner must be an active member of the same tenant, change tracking, soft delete,
  company links, English/Arabic/phone/partial-email search with literal wildcards, keyset
  pagination over all five sorts, bulk actions skipping foreign ids, tags incl. foreign tag
  rejection); custom fields (all value types, required, unknown/archived keys, filters,
  immutability, duplicate keys); tenant isolation (RLS on direct read/update/insert, guessed
  ids, cross-tenant references rejected by services and by composite FKs, foreign pipeline
  stages, search); linked-name redaction; contact limit under 6 concurrent creates; pipeline
  limit; single default pipeline under concurrent first reads; deal transitions and event
  sequence; board ordering with 60 moves forcing renormalization and per-currency totals;
  negative values and explicit currency changes; pipeline structure guards; task due windows
  and completion events; note ownership; import (mapping, preview, duplicates, formula
  unescape, limit enforcement, idempotent re-run, cancellation, bad mappings, isolation);
  export (filters, formula escaping, creator-only download, cross-tenant).
- API (9 new, 124 total): role → capability matrix, 404 for non-members, link-read
  enforcement and name redaction, one test touching every CRM resource from another tenant
  (11 reads, 21 writes, bulk, references, lists, search), mass assignment, full HTTP workflow
  with validation errors, custom field filters and audit, import and export over HTTP
  including headers and audit.
- E2E (Playwright): contact → note → task → deal on the board → move to Won → CSV import via
  the worker → export download → search → other tenant gets 404.
- Full suite (uncached): 334 unit/integration + 6 E2E passing.

### Fixed during the phase

- Turborepo cache keys did not include internal package sources, so lint/typecheck/test/build
  could replay stale results after package changes (`globalDependencies` now hashes them).
- `foundation.test.ts` flushed the shared test Redis database while other files ran in
  parallel, intermittently erasing rate-limit counters (root cause of the earlier one-off
  rate-limit test failure). Removed; contexts already use unique key prefixes.
- A local Redis snapshot (`dump.rdb`, test counters only) had been committed; untracked and
  ignored.

### Risks

- Phone-digit search uses `LIKE '%digits%'` (unindexed within an organization); add trigram
  indexes in Phase 26 if needed.
- Import staging rows and export files live in Postgres until file storage (Phase 16).
- Contact counting for `crm.contacts.max` is O(contacts) per create; a counter can replace it
  in Phase 26.
- Arabic letter-variant normalization (أ/ا, ى/ي) is not applied to search yet.

### Next

- Phase 9: unified activity timeline across CRM records (notes, tasks, deal changes, future
  messages/appointments/invoices) with a cross-module-ready model.

---

## Phase 7 — Payments

Status: PASSED

### Completed

- Provider abstraction, Tap adapter (CONFIGURATION_REQUIRED), fake provider, payment service,
  webhooks with replay protection, subscription checkout/activation/maintenance, UI.

### Tests

- payments unit (11): Tap request shape (BHD decimals, BENEFIT source, callbacks, auth,
  idempotency), retrieval mapping, float-safe amount conversion, status mapping, forward-only
  transitions, configuration-required without network calls, error wrapping without leaking
  bodies, suspicious ids, hashstring computation, valid/missing/wrong/tampered signatures.
- payments integration (16): server-side pricing, private/free price refusal, pending sync is a
  no-op, 3 concurrent syncs fulfil once (items, billing event, payment event, entitlements),
  amount and currency tampering refused, no regression on stale responses, failed payments,
  early renewal extension, forged/unsigned webhooks rejected and recorded, signed webhook
  claiming success verified against the provider, replay deduplication, unknown
  payment/provider handling, tenant read-only RLS, past_due → paused lifecycle with
  entitlements, checkout expiry, month-end interval clamping.
- API (9): config, server pricing ignoring client amounts, permission + isolation, forged
  return-page hints ignored until provider confirms, no status write routes, raw-body
  signatures (tampered and re-serialized bodies rejected), replay, unknown provider, dev route
  creator guard, production env refusal.
- E2E: hosted checkout subscription flow (forged return visit first, then real payment).
- Full suite: 285 unit/integration + 5 E2E passing.

### Risks

- Tap integration unverified against a live sandbox (no credentials): CONFIGURATION_REQUIRED.
- Refund notifications are not processed yet (Phase 14 commerce refunds).
- Recurring card charging not implemented (ADR-026).

### Next

- Phase 8: CRM — contacts, companies, pipelines, stages, deals, tasks, notes, tags, custom
  fields with tenant isolation and E2E.

---

## Phase 6 — Billing + Entitlements

Status: PASSED

### Completed

- Plans as data with versions, prices (BHD minor units) and typed entitlements; resolution with
  overrides and a restrictive fallback; subscriptions changed only via system paths.
- Atomic, idempotent monthly quota metering in the organization's timezone; seat limits.
- Billing endpoints and page; example catalogue seed.

### Tests

- billing (20): registry validation, timezone periods, catalogue versioning/visibility,
  invalid catalogue input, unpublished versions refused, fallback/plan/past_due/paused
  resolution, override precedence and expiry, plan change events, default plan subscription
  (rolled-back transaction), single live subscription, tenant write attempts blocked by RLS
  (subscriptions, overrides, billing events, catalogue), tenant read isolation, 25 concurrent
  consumes → exactly 10 succeed, idempotency keys, rollback on exceeded quota, unlimited
  quotas, local-month metering, cross-tenant consumption blocked, concurrent seat reservation.
- API (13): invitation limit 402, re-invite seat neutrality, 6 concurrent invites → 2 succeed,
  join blocked after downgrade, reactivation blocked, read-only entitlements, tenant isolation,
  no subscription write routes / smuggled fields, billing permission, profile validation and
  audit, catalogue prices as BHD decimal strings.
- Full suite: 248 unit/integration + 4 E2E passing.

### Risks

- Gauge limits beyond seats are enforced as modules land (contacts, pipelines, workflows,
  storage).
- Annual vs monthly quota alignment is calendar-month only (ADR-024).

### Next

- Phase 7: payment provider abstraction, Tap adapter, webhooks, checkout for subscriptions.

---

## Phase 5 — Audit + Events + Jobs

Status: PASSED

### Completed

- Append-only audit log covering auth and organization administration, with UI.
- Domain events via transactional outbox; dispatcher with SKIP LOCKED, leases, backoff and
  failed state; subscriber registry; once-only processing helper.
- Typed job system (BullMQ) with retries/backoff, payload validation, idempotent enqueue,
  dead-letter persistence; emails moved to `email.send` jobs; worker health endpoint.

### Tests

- worker (14, real Redis + Postgres): delivery with full envelope, rollback emits nothing,
  invalid event payloads rejected, cross-tenant emit blocked by RLS, transient failure retries
  with backoff, unrecoverable failures dead-lettered, invalid job payloads fail permanently,
  re-dispatch delivers once, `processOnce` dedupe, concurrent dispatchers exactly-once,
  crash-recovery reclaim, system.ping, email delivery, enqueue validation.
- events (5): fan-out with deterministic ids, no-subscriber dispatch, enqueue-failure backoff
  → failed, not-yet-due events untouched, registry validation.
- jobs (5), API audit/events (8): attribution, permission + tenant isolation, pagination and
  filter validation, append-only enforcement (tenant and system scope), security events
  without secrets, events with correlation ids, rejected actions emit nothing, queued email.
- Full suite: 215 unit/integration + 4 E2E passing.

### Risks

- Outbox and processed_events need retention/cleanup jobs (Phase 26/29).
- Email delivery is CONFIGURATION_REQUIRED in production until a provider adapter lands.

### Next

- Phase 6: plans, plan versions, prices, subscriptions, entitlements, usage metering with
  server-side enforcement.

---

## Phase 4 — RBAC

Status: PASSED

### Completed

- Permission catalogue (organization.update, settings.users.manage, settings.roles.manage),
  five system roles derived from code, custom roles, multi-role assignments.
- Escalation guards: subset rule for granting/defining/inviting, no managing more powerful
  members, owner-only owner grants, at-least-one-owner invariant with organization row lock.
- Member management, role management, invitation management, organization settings — API + UI.

### Tests

- permissions: 10 unit tests (catalogue integrity, derivation, filtering, guards).
- API RBAC suite: 37 tests — permission matrix (403 for members, 404 for non-members on every
  guarded endpoint), owner-grant attempts, managing owners, delegated manager escalation
  attempts (assign, self-assign, define role, invite), system role immutability, unknown
  permissions, immediate effect of role changes, cross-tenant role/member/invitation/role-edit
  references, DB-level rejection of cross-tenant assignments, last-owner rules, ownership
  transfer, concurrent demotion race, suspension/removal effects, invited role assignment.
- E2E: invite → accept → restricted UI → promotion takes effect.
- Full suite: 186 unit/integration + 4 E2E passing.

### Risks

- Permission resolution adds one query per tenant request (inside the same tenant transaction
  as membership resolution). Revisit with caching in Phase 26 if needed.

### Next

- Phase 5: audit log, domain events with transactional outbox, job abstraction with retries,
  idempotency and dead-letter visibility; audit existing sensitive actions.

---

## Phase 3 — Authentication

Status: PASSED

### Completed

- Registration, email verification, login, logout, sessions, forgot/reset password, change
  password, invitation preview/acceptance (existing and new accounts), organization creation
  and switching — API and web UI.
- Hardening: enumeration-resistant responses, timing equalization, per-account lockout and
  per-IP limits, session fixation prevention, token single-use and email binding, CSRF origin
  check, `__Host-` cookies in production, open-redirect guard, `no-store`, proxy trust config.

### Tests

- auth package: 24 (registration branches, pre-hijack, verification, expiry, rehash, reset,
  change password, invitations incl. cross-tenant invitation attempt).
- API: 49 (protected-route matrix, cookie attributes, forged/revoked cookies, fixation, reset
  revocation, CSRF, non-JSON refusal, org creation/switching, mass assignment, cross-tenant
  404s, suspended membership, invitation flows, strict rate limits).
- Web unit: 9 (redirect validation). E2E (Playwright): 3 full-stack flows.
- Full suite: 138 unit/integration + 3 E2E passing.

### Risks

- Production cannot start until an email provider exists (by design, CONFIGURATION_REQUIRED).
- Global rate limit is per IP; authenticated per-user limits are applied per sensitive route.
- A one-off failure of the per-IP registration limit test was seen once and not reproduced in
  9 further runs; the assertion now prints the full status list if it recurs.

### Next

- Phase 4: permission catalogue, system + custom roles, assignments, escalation guards,
  member management and invitation endpoints with permission checks.

---

## Phase 2 — Database + Tenancy

Status: PASSED

### Completed

- Tables: users (global), organizations (tenant root), memberships, organization_settings.
- RLS on every table, `FORCE ROW LEVEL SECURITY`, policies driven by transaction-local
  settings; runtime role sees nothing outside a scope.
- Scoped transaction helpers with branded types; Postgres error helpers.
- Organizations domain package (create/list/resolve/update/members/settings).
- Decision: no workspace/location tier yet (ADR-011).

### Tests

- 24 tenancy tests: RLS coverage guard (every public table must have RLS enabled, forced and
  policies), no access outside scope, Org A cannot read/list/search/update/delete/insert/move
  rows into Org B, guessed IDs return nothing/404, no context leakage across pooled
  connections, malformed scope ids rejected, multi-org users isolated per tenant, suspended
  members and inactive organizations denied, settings isolation and validation, slug
  allocation (incl. Arabic names), regional validation.
- Full suite: 73 passing.

### Risks

- RLS subqueries on `memberships` for `users`/`organizations` visibility; indexed, revisit in
  Phase 26 with real query plans.
- HTTP-level tenant resolution arrives with authentication in Phase 3.

### Next

- Phase 3: registration, verification, login/logout, sessions, password reset, invitations,
  organization creation and switching over HTTP.

---

## Phase 1 — Monorepo Foundation

Status: PASSED

### Completed

- pnpm workspace + Turborepo (`build`, `lint`, `typecheck`, `test`, `dev`), Prettier,
  EditorConfig, `.nvmrc`, `.env.example`, committed `.env.test` (local URLs only).
- `packages/config`: shared tsconfig bases (strict, `noUncheckedIndexedAccess`, Bundler
  resolution), type-aware flat ESLint config (typescript-eslint strict), Next ESLint config,
  Zod env helpers.
- `packages/shared`: `AppError` hierarchy, UUIDv7 `newId()` (monotonic), BHD-correct `Money`
  (bigint minor units, currency registry, rounding modes, allocation, VAT-style percentages),
  cursor pagination helpers, log redaction.
- `packages/database`: Drizzle + node-postgres client (int8 never parsed as float),
  advisory-locked migration runner, readiness ping, foundation migration with RLS helper
  functions (`app_current_org()`, `app_current_user()`, `app_is_system()`).
- `apps/api`: Fastify 5 app factory with validated env (production refuses http origins),
  pino with redaction, request IDs (safe upstream propagation), helmet, CORS allow-list,
  Redis-backed global rate limit, standard error envelope (no internals leaked),
  `/health/live` + `/health/ready`, graceful shutdown.
- `apps/worker`: BullMQ bootstrap, validated env, `system.ping` processor, failure logging,
  graceful shutdown.
- `apps/web`: Next.js 16 + Tailwind 4 skeleton, `/api/*` same-origin rewrite, security headers,
  real `/status` page backed by `/health/ready`.
- `docker-compose.yml` (Postgres 16, Redis 7), `pnpm db:setup` (runtime role `businessos_app`,
  NOSUPERUSER/NOBYPASSRLS), CI workflow (format, migration sync, lint, typecheck, test, build).
- `scripts/verify-bundle-deps.mjs`: build fails if a bundled app imports an undeclared package.

### Tests

- 49 passing: shared (27), database (3, incl. runtime role has no RLS bypass), api (17: health,
  request ids, error envelope, no internal leakage, mass-assignment stripping, malformed JSON,
  body limit, security headers, CORS allow-list, rate limiting), worker (2: job round trip,
  unknown job fails visibly).
- Manual smoke: built API and worker start, serve health, shut down gracefully.

### Risks

- Rate limiter fails open if Redis is unavailable (availability choice; readiness reports it).
  Auth-specific limits in Phase 3 will be reconsidered.
- CI workflow not yet executed on GitHub (cannot run Actions from the sandbox).

### Next

- Phase 2: users, organizations, memberships, settings, tenant context, RLS policies,
  cross-tenant tests.

---

## Phase 0 — Repository Audit

Status: PASSED

### Completed

- Audited repository: Vercel "Express on Vercel" sample only. Decision: replace (ADR-002).
- Environment: Node 22.22, pnpm 10.28, PostgreSQL 16 and Redis available locally; Docker
  daemon unavailable in the build sandbox (docker-compose provided for developers).
- Created CLAUDE.md and the docs set.

### Risks

- Scope is very large; phases must stay disciplined to avoid shallow breadth.
- RLS adds a transaction per tenant request; re-evaluate in Phase 26.
