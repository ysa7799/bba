# Build Progress

## Current Phase

Phase 18 — Integrations framework

Status: NOT_STARTED

---

## Phase 17 — Public API + webhooks

Status: PASSED

### Completed

- Schema: `api_keys` (SHA-256 only, display prefix, scopes, creator, expiry, revocation),
  `api_idempotency_keys`, `webhook_endpoints` (sealed signing secret plus the previous one
  during rotation, subscribed events, on/off with reason, failure count) and
  `webhook_deliveries` (exact body, status, attempts, next attempt, last response); FORCE RLS;
  composite same-tenant FKs. Migrations 0033–0034.
- `@businessos/safe-http`: the SSRF-guarded client (https only, public addresses checked at
  connect time, no credentials, no redirects, own hosts refused) moved out of automation and
  shared; posts exact bodies; overall deadline.
- `@businessos/api-keys`: 256-bit keys shown once; scopes from a fixed public list, held by the
  creator at creation and narrowed to the creator's **current** permissions on every request
  (suspended or removed creators disable their keys); 25 active keys per organization;
  expiry; revocation; throttled last-used tracking; idempotency records (claim, replay,
  mismatch, in-progress, takeover, release, prune).
- `@businessos/webhooks`: endpoints (URL safety, 20 per organization, encrypted secrets,
  rotation with a 24-hour overlap, on/off), public catalogue of 36 event types with a versioned
  envelope, HMAC-SHA256 signatures over `<timestamp>.<body>` and a verification helper,
  `webhooks` subscriber (fan-out when the plan includes the API), signed attempts with
  retries (1 min → 24 h, 8 attempts; per-attempt job ids so stale jobs do nothing), 410 and
  15 consecutive failures turn an endpoint off, test events, redelivery, delivery log,
  maintenance (lost attempts re-queued, 30-day retention).
- Permission `api.manage`; audit actions for keys and endpoints; CRM actor `api_key`.
- API: `/api/v1` — me, contacts, companies, deals (+ move), tasks, invoices (read) with scope
  checks, link-read checks, audit of deletions, `Idempotency-Key` on creates, per-key,
  per-organization and failed-auth rate limits, `no-store`; `/app/orgs/:orgId/developers`
  management (keys, endpoints, rotation, test, deliveries, redeliver).
- Worker: dedicated `webhooks` queue, `webhook.deliver` and hourly `developers.maintenance`.
- Web: "API & webhooks" page (base URL and usage notes, keys with one-time reveal and revoke,
  endpoints with one-time secret) and endpoint page (test event, on/off, edit, rotate, delete,
  delivery log with payloads, resend, paging); plan gate explained with a link to billing.

### Tests

- safe-http (3): exact bodies and headers, non-2xx reporting, overall deadline against a slow
  drip, private destinations refused.
- api-keys (11): key shown once and stored only as its hash, **no escalation** through scopes,
  unknown/revoked/expired/suspended-organization keys refused, **scopes narrowed to the
  creator's current permissions and suspended creators disable their keys**, throttled
  last-used, **keys stay inside their organization** (filters and RLS), active-key limit,
  bearer parsing; idempotency replay, mismatch (422), in progress (409), release, takeover,
  per-key scoping, validation and pruning.
- webhooks (15): **signatures** (exact body, tolerance, replay and forged timestamps, wrong
  secret, rotation with two secrets); endpoints (secret once and encrypted, unsafe URLs and
  unknown events refused, on/off, rotation overlap, **cross-tenant 404s** for every action);
  deliveries (fan-out only to the organization's subscribed endpoints, once; nothing without
  the API in the plan; exact signed body; retries on schedule, stale jobs skipped, final
  failure counted, redelivery; 410 and repeated failures turn endpoints off; **private
  destinations refused at send time** (DNS rebinding); test events; private delivery log;
  maintenance).
- API (9): key management per permission and plan, revocation, audit without the key;
  **key-only authentication** (no header, bad key, Basic, a session cookie all 401); scopes per
  operation; **a key never reaches another organization** (get, update, delete, search, links,
  smuggled `organizationId`); idempotent creates; `api_key` actor on events and audit; per-key
  rate limit; webhook management, signed test delivery, delivery log and payload, rotation,
  on/off, cross-tenant 404s, audit; unsafe URLs refused in a strict configuration. Production
  configuration refuses `WEBHOOKS_ALLOW_PRIVATE_NETWORK` (API and worker).
- E2E: the plan gate, a key created in the UI creating a contact through the public API
  (idempotent replay, scope refusal, no key → 401), the new contact delivered to a local
  receiver as a correctly signed `contact.created` (verified independently with HMAC), a test
  event shown in the delivery log, revocation taking effect immediately.
- Full suite (uncached): 606 unit/integration + 16 E2E passing.

### Risks

- The public API covers CRM records and invoices (read); other modules follow as they need
  integrations. No OpenAPI document yet (planned with the API hardening in Phase 25).
- Entitlement and creator checks add a few queries per API request; cache them if the API
  becomes hot (Phase 26).
- Workflow `http.request` steps are still unsigned (signed endpoints are the supported way to
  receive events).

### Fixed during the phase

- API keys outlived their creator's access (security finding, MEDIUM): scopes are now
  narrowed to the creator's current permissions per request.
- The endpoint page called a client-only helper from a server component (found by E2E).
- A calendar isolation test built an empty slot range on dates whose next workdays fall on the
  same day after the Friday–Saturday weekend (date-dependent failure); it now asks for one day.

### Next

- Phase 18: integrations framework (encrypted credentials, connection state machine).

---

## Phase 16 — Files + notifications

Status: PASSED

### Completed

- Schema: `files` (pending/ready/deleted, size, SHA-256, server-generated storage key, attached
  contact/company/deal), `notifications` (unique per user, type and source event; link checked
  to stay inside the organization) and `notification_preferences`; FORCE RLS; notifications and
  preferences use an **owner-only** policy (organization and user). Migrations 0030–0032.
- `@businessos/files`: `FileStorage` port — S3-compatible adapter with in-house SigV4 (verified
  against AWS's published example; `CONFIGURATION_REQUIRED` without a bucket and keys), local
  disk (development only; refused in production; keys confined to its root) and memory (tests).
  Type detection from the bytes against an allow-list (PNG, JPEG, GIF, WebP, PDF, UTF-8
  text/CSV, DOCX/XLSX/PPTX; never HTML, SVG, archives or executables); safe names (no paths,
  control characters, quotes or bidirectional overrides; extension always matches the detected
  type); 10 MB maximum; `storage.bytes` quota reserved inside the organization's advisory lock
  before the object is written; SHA-256 verified on every read; hourly `files.maintenance`
  (abandoned uploads, deferred deletions).
- `@businessos/notifications`: nine types (task assigned, conversation assigned, deal won,
  appointment booked, quote accepted/declined, invoice paid/overdue, workflow failed) built from
  domain events by the `notifications` outbox subscriber; every recipient re-checked at delivery
  (active membership, read permission, not the actor, channel choices); in-app rows and
  `notification` emails (deterministic job ids); inbox (list with cursor, unread count, mark
  read, mark all read); per-member preferences limited to receivable types; hourly retention
  (read after 90 days, unread after a year).
- API: `/app/orgs/:orgId/files` (list, raw-body upload, download with `nosniff`, attachment
  disposition and a sandbox CSP, delete; access follows the record's read/update permissions;
  audited; rate limited) and `/app/orgs/:orgId/notifications`; storage usage in the billing
  entitlements; env `FILES_STORAGE`, `FILES_LOCAL_DIR`, `S3_*` (production requires S3).
- Worker: notifications subscriber, `notification` email template, `files.maintenance` and
  `notifications.maintenance` schedules.
- Web: attachments panel on contact, company and deal pages (upload, open images, download,
  delete); notification bell with unread count in the header (refreshed on navigation, focus
  and every minute); notifications page (all/unread, mark read, mark all read, show more,
  channel preferences); file storage usage on the billing page; the proxy allows 10 MB uploads
  and forwards download safety headers.

### Tests

- files (14): type detection by bytes, refusal of scriptable and unknown formats, safe names,
  **bidirectional overrides stripped**, **extension matches the detected type**, SigV4 against
  AWS's example, S3 `CONFIGURATION_REQUIRED` and signed requests, local storage confinement,
  store/list/read/delete, empty/oversized/disallowed uploads, **quota under parallel
  uploads**, reservation released on storage failure, damaged objects detected, **files stay
  inside their organization**, maintenance.
- notifications (8): delivery in-app and by email once per event, no self-notification,
  **membership and permission re-checked at delivery**, withheld when the recipient may not
  read the subject, channel choices, **private inbox** (other members and other organizations
  see nothing, RLS and filters), preferences limited to receivable types, retention.
- API: attachments with access following the record, download headers, **cross-tenant 404s**
  (list, download, upload, delete), audit entries; disguised, renamed, oversized and
  cross-site uploads; private notifications, unread count, mark read, preferences; production
  configuration refuses local storage and requires a bucket.
- Worker: `notification` email template; production configuration.
- Web unit: byte formatting, proxy upload limit, forwarded download headers.
- E2E: attach an Arabic-named PDF to a contact, download the exact bytes under its name with
  the sandbox headers, a renamed web page refused, delete; a task assigned to a teammate
  reaches their bell, notifications page and inbox (email), mark all read, email preference
  saved, unavailable types hidden.
- Full suite (uncached): 568 unit/integration + 15 E2E passing.

### Risks

- Downloads stream through the API and web proxy (10 MB cap); larger files will need presigned
  direct uploads/downloads (ADR-052).
- No antivirus scanning yet: files are limited to inert formats and always served as
  downloads (images inline only); add a scanning hook before allowing more types.
- The bell polls once a minute; no push channel yet (ADR-053).
- Notification texts are English until the Arabic catalogue lands.

### Fixed during the phase

- The web app's global CSP replaced the API's sandbox policy on downloads (security finding,
  MEDIUM); the proxy now forwards it and the download path is exempt from the page policy.
- Stored names could carry a misleading extension or bidirectional overrides (LOW).
- Two catalogue tests depended on leftovers in the shared test database (the plan list is
  bounded); they now sort their plan first and restore the catalogue.
- E2E browsers run with a UTF-8 locale so non-Latin download names are kept.

### Next

- Phase 17: public API (API keys) and outbound webhooks.

---

## Phase 15 — Dashboards + reporting

Status: PASSED

### Completed

- `@businessos/reporting`: report periods resolved by PostgreSQL in the organization's time zone
  (day, ISO week, month; ≤ 366 days; sensible defaults); results as exact decimal strings
  (counts, per-currency money never converted, percentages from integers) with series bar
  scales computed on the server; eight reports — sales pipeline (open/weighted/won value per
  currency, win rate, deals by stage), revenue (invoiced, collected, refunded, net,
  outstanding, overdue, top customers), contacts (new, by source, by lifecycle stage), tasks
  (open, overdue, mine, completed, by assignee), conversations (open, unassigned, messages in
  and out, by channel), appointments (booked, held, no-shows, cancellations, next 7 days, by
  type), forms (submissions, spam, by form) and automation (runs, failures, success rate, by
  workflow); this-month dashboard; CSV export.
- Permission `reports.read`; every report also requires its module's read permission (API,
  service and dashboard); names withheld without the matching read permission; audit action
  `reports.exported`.
- Migration 0029: per-period reporting indexes on messages, conversations, form submissions,
  runs, invoice payments, refunds, deals, tasks and invoices.
- API: `/app/orgs/:orgId/reports` (list, dashboard, report, CSV), rate limited per user.
- Web: dashboard on the overview (headline tiles and a chart per permitted report), Reports page
  (report tabs, period form that works without JavaScript, stat tiles, single-hue bar charts
  with per-bar hover/focus tooltips and data tables, breakdown tables, CSV download). Chart color
  validated against the card surface (dataviz six checks: pass). Fixed the content column not
  filling wide screens.

### Tests

- reporting (8): UTC boundaries of local days; defaults and bounds; Monday weeks and months;
  records counted on their **local day** around midnight; **other tenants excluded**; per-currency
  pipeline sums and probability weighting; win rate; revenue invoiced/collected/refunded/net/
  outstanding/overdue exact to the fils; customer names **withheld without contact access**;
  available reports, forbidden reports and dashboard widgets per permission set; every report on
  an empty organization; **CSV formula escaping**.
- API (3): reports per role (owner, member without automation, restricted with none);
  organization-only counts, cross-tenant 404, period validation, weekly buckets; CSV download
  headers, BOM and audit entry; 403 for forbidden exports.
- E2E: dashboard on the overview, contacts report with chart and tables, CSV download, an
  invalid period explained.
- Full suite (uncached): 539 unit/integration + 13 E2E passing.

### Risks

- Reports read operational tables directly; very large organizations may need rollups or a
  read replica (measure in Phase 26).
- No saved or scheduled reports yet, and no comparison with the previous period.
- Reports are English-only until the Arabic catalogue lands (labels are already in i18n).

### Fixed during the phase

- The app's content column did not fill wide screens (layout).
- An existing E2E assertion matched any "BHD" on the overview; it is now scoped to the
  organization details (the dashboard shows BHD amounts too).

### Next

- Phase 16: files and notifications.

---

## Phase 14 — Commerce

Status: PASSED

### Completed

- Schema (12 tables, FORCE RLS, composite same-tenant FKs, money as `bigint` minor units with
  an explicit currency everywhere): commerce settings (prefixes, next numbers, payment terms,
  footer), tax rates, products and per-currency prices, quotes and invoices (server-computed
  totals, hashed customer link tokens, gapless issued numbers), line items (exact quantities,
  tax snapshots), payment connections (sealed credentials, one live per organization),
  checkouts, applied payments (online or manual) and refunds.
- `@businessos/commerce`: integer commercial arithmetic (per-line half-up rounding, totals as
  sums of rounded lines, bounds); catalogue; quotes (draft, send with a new link each time,
  customer accept/decline within validity, staff answers, convert to an invoice with the agreed
  amounts, expiry); invoices (drafts, issue with gapless number and dates in the organization's
  time zone, customer links, re-send, void, overdue once); payment connections (Tap per
  organization, development fake, CONFIGURATION_REQUIRED without keys); online checkout for the
  amount due (reused while pending) with server-side verification applied once; per-connection
  webhooks; manual payments capped at the amount due; refunds bounded by what remains
  (provider refunds reserved first, released if refused); overpayments recorded; timeline
  projectors.
- Catalogue: permissions `commerce.*` (6); events `quote.*` (3) and `invoice.*` (5); audit
  actions `commerce.*`; activity types for quotes and invoices; job `commerce.maintenance`;
  email templates `quote_sent`, `invoice_sent`; workflow triggers `invoice.created`,
  `invoice.paid`. Platform billing webhooks and sync now ignore invoice payments.
- API: staff `/app/orgs/:orgId/commerce/*` (audited), customer `/public/commerce/*` (rate
  limited, link tokens masked in logs), `/webhooks/commerce/:connectionId`; env
  `COMMERCE_FAKE_PAYMENTS` (refused in production).
- Worker: hourly `commerce.maintenance`; quote and invoice entries on contact timelines.
- Web: Quotes, Invoices (editor with product prices and taxes, detail with payments, refunds
  and online attempts, issue/re-send with copyable link and email, record payment, refund,
  void, print/save-as-PDF view), Products, Invoicing setup (tax rates, numbering and footer,
  payment provider); customer pages `/i/<token>` (pay online, verified on return) and
  `/q/<token>` (accept/decline); "New invoice" on contacts; development fake checkout.

### Tests

- commerce (23): BHD/JPY arithmetic, exactness and bounds; prices per currency (no silent
  conversion, no rounding of over-precise input); server-computed totals ignoring client
  fields; **gapless numbering under concurrency** (with a rolled-back issue); immutability of
  issued invoices; customer links (rotation, void); overdue once; quote → acceptance →
  invoice with the agreed amounts (once) and the timeline entry; quote expiry; **payment
  integrity**: concurrent webhook + duplicate webhook + sync + return-page refresh apply a
  payment once and emit `invoice.paid` once; webhook status never trusted; **tampered amount**
  refused; partial payments (manual then online for exactly the remainder); no manual
  overpayment; late second online payment recorded as overpaid; **refund bounds including
  concurrent refunds**, reopening and voiding; manual refunds; forged/unsigned webhooks; no
  online payment without an active connection; sealed credentials (never returned, bound to
  the connection); **tenant isolation** across every service, foreign references and another
  organization's webhook endpoint.
- payments (+1): subscription webhooks and sync never touch invoice payments.
- API (6): totals and privileged fields; permissions per role; cross-tenant 404s; emailed link
  → public page → checkout → dev completion → verified paid, webhook replay and forged
  signature, link token never logged; quote send/accept/convert; credentials never returned.
  Worker: commerce email templates. Shared: link-token masking.
- E2E: tax rate and fake provider setup, product in BHD, invoice priced from the product with
  VAT, issue and email, customer pays online through the hosted page and sees it paid, staff
  sees the online payment; quote sent, accepted by the customer, converted to an invoice.
- Full suite (uncached): 528 unit/integration + 12 E2E passing.

### Fixed during the phase

- `?includeArchived=false` was read as true by the product list (see SECURITY findings).
- A price archive update relied on RLS alone (see SECURITY findings).
- The worker's outbox concurrency test timed out under the full parallel suite: its single
  runtime dispatcher drains every suite's events from the shared test database. The extra
  dispatchers now keep racing until delivery (stronger concurrency, same exactly-once
  assertions) with a deadline that allows for the backlog.

### Risks

- Not an accounting system: no ledger, credit notes or tax reports yet (accounting design is a
  later phase). Refunds reopen invoices; staff void what should not be collected.
- Tap invoice payments are CONFIGURATION_REQUIRED until validated against a Tap sandbox
  account; provider-side refunds made outside BusinessOS are only logged for reconciliation.
- Payments pending with a connection that is later disconnected can no longer be verified.
- Customer link tokens are part of the provider return URL (the organization's own provider).
- Commerce has no plan entitlement yet; module gating arrives with the module-gates phase.

### Next

- Phase 15: dashboards and permission-aware reporting.

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
