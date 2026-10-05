# Security

Security and tenant isolation are the top two engineering priorities. This document is the
threat model and the control catalogue; it is updated whenever a control is added.

## Threat model (summary)

| Asset         | Main threats                                                   | Primary controls                                                                                  |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tenant data   | Cross-tenant reads/writes, IDOR, search leakage                | Membership-based tenant resolution, explicit org filters, Postgres RLS, isolation tests           |
| Accounts      | Credential stuffing, session theft, reset-token abuse          | argon2id, rate limits, opaque hashed session tokens, httpOnly cookies, single-use expiring tokens |
| Authorization | Privilege escalation, role tampering                           | Server-side permission checks, role-assignment rules (cannot grant above own level), audit        |
| Payments      | Forged success, replayed webhooks, amount tampering            | Server-side verification, signed webhooks, idempotency, server-computed totals                    |
| Integrations  | Token theft, credential leakage                                | Envelope encryption at rest, never sent to browser, scoped access                                 |
| Platform      | SSRF via webhooks/HTTP actions, host-header attacks, XSS, CSRF | URL allow/deny rules, private-IP blocking, host allow-list, CSP, SameSite + origin checks         |
| AI            | Prompt injection → tool abuse                                  | Tools run with the user's permissions, input validation, approval for high-risk actions           |

## Controls

### Tenant isolation

- Organization is the tenant; every tenant row carries `organization_id`.
- Three layers (request → repository → RLS); see `ARCHITECTURE.md §3`.
- Resources in another organization return **404**, never 403, so IDs cannot be probed.
- Client-supplied foreign keys are re-validated inside the tenant.
- Mandatory isolation tests per resource: read, list, search, update, delete, reference,
  guessed-ID probing.

### Authentication (Phase 3 — implemented)

- Passwords: argon2id (memory-hard), min length 10, max 256, breached-pattern checks later.
- Sessions: 256-bit random opaque token in `__Host-`/httpOnly/Secure/SameSite=Lax cookie; only
  the SHA-256 hash is stored. Idle + absolute expiry; rotation on privilege change; revocation
  on password reset.
- Email verification, password reset, invitations: single-use, hashed, short-lived tokens.
- Login responses do not reveal whether an email exists. Constant-time comparisons.
- Prepared for OAuth (Google, Microsoft), MFA (TOTP/WebAuthn), passkeys, SAML via an
  `identities` table separate from `users`.

- Registration never reveals existing accounts; an unverified email belongs to its latest
  registrant (pre-hijack protection); verified accounts receive an "account exists" email.
- Login: identical error + dummy argon2 verification for unknown emails; per-account failure
  lockout (5 / 15 min) independent of IP; per-IP limits; fresh session on every login.
- Reset: single-use 1-hour token bound to the email it was sent to; completing a reset revokes
  all sessions and marks the email verified; only the newest token per purpose is valid.
- Invitations: bound to the invited email; the token proves mailbox ownership.
- Rate limiter fails open when Redis is unavailable (availability choice); argon2 cost still
  throttles guessing. Revisit in Phase 25.

### CSRF

- Session cookies are `SameSite=Lax`; all state-changing first-party requests must carry a
  matching `Origin` (or `Referer`) from the allow-list, and JSON content type (other content
  types get 415).

### Client IP attribution

- The API trusts `X-Forwarded-For` only from configured proxies (`TRUST_PROXY`: hops/CIDRs).
- The web proxy forwards `X-Forwarded-For` only with `TRUST_PROXY_HEADERS=true` (set when the
  web tier sits behind a load balancer that overwrites the header).

### Authorization _(Phase 4)_

- Granular permissions (`module.resource.action`), predefined + custom roles.
- Users cannot assign roles/permissions they do not hold themselves; owners cannot be
  removed by non-owners; the last owner cannot leave.

### Input validation

- Zod schemas at every boundary; unknown keys stripped; explicit allow-lists for writable
  fields (no mass assignment).
- Request body size limits; upload MIME/extension/size validation; CSV-injection escaping on
  export.

### Secrets

- No secrets in the repo; `.env*` ignored except `.env.example`.
- Env validated at startup; production refuses insecure defaults.
- Integration credentials encrypted with `SecretBox` (AES-256-GCM, keys from
  `CREDENTIALS_ENCRYPTION_KEYS` = `id:base64key[,…]`, first key encrypts, all decrypt; the key
  id is stored in each ciphertext for rotation; associated data binds a ciphertext to its
  organization and record). Required in production for the API and the worker.
- API keys: shown once, stored as SHA-256 hash with prefix for lookup.
- Log redaction for `password`, `token`, `authorization`, `cookie`, `secret`, `apiKey`, etc.
  Request URLs are logged through `redactUrlForLog`: webhook routing tokens in paths and
  sensitive query values (`token`, `hub.verify_token`, …) are masked.

### Rate limiting

- Redis-backed; policies per route class (login, register, forgot-password, public forms,
  booking, public API, uploads, messaging, AI, import/export) and per dimension (IP, user,
  organization, API key).

### Headers

- `helmet` defaults, HSTS in production, CSP on the web app, `X-Request-Id` on all responses.

### Payments _(Phase 7)_

- Never trust client-reported success. Paid state from verified webhooks or server-side
  provider API calls only. Idempotent webhook processing with replay protection.

### SSRF _(Phase 13/17)_

- Outbound HTTP (workflow webhooks, customer webhooks) resolves DNS and blocks private,
  loopback, link-local and metadata ranges; HTTPS only in production; timeouts and size caps.

### Platform admin _(Phase 24)_

- Separate from tenant RBAC, all actions audited, no silent impersonation.

### Audit trail (Phase 5)

- Sensitive actions are audited in the same transaction as the change: sign-in (success and
  failure for known accounts), sign-out, email verification, password reset request/complete,
  password change, organization create/update/settings, invitations, joins, role changes,
  suspensions, removals, leaving, custom role create/update/delete.
- `audit_logs` is append-only at the database level (forced RLS with no UPDATE/DELETE
  policies), metadata is redacted (`redactSensitive`) and size-capped, IP addresses validated.
- Reading requires `audit.read` and is tenant-isolated; account-level records (no
  organization) are only readable in system scope (platform admin, Phase 24).

### Jobs

- Job payloads are validated on enqueue and processing; failures are logged with correlation
  ids and persisted (redacted) to `job_failures`.
- Email jobs carry links containing single-use tokens; they live in Redis only until the job
  completes (`removeOnComplete`) — Redis must be private and encrypted in transit in production.

### Billing integrity (Phase 6)

- Clients can never change plan state: no write endpoints; tenant scope has no RLS write policy
  on subscriptions/overrides/billing events; catalogue writes require system scope.
- Limits are enforced server-side at the point of use; quota consumption is atomic and
  idempotent; seat checks lock the organization row.

### Payments (Phase 7)

- Payment success is never taken from the client or a redirect: only from `retrievePayment`
  (provider API) triggered by verified webhooks, return-page verification or reconciliation.
- Amount/currency/reference must match the stored payment; mismatches are refused and logged.
- Webhook signatures are checked over the raw body with constant-time comparison; replays are
  deduplicated; invalid attempts are recorded.
- Tenants cannot write payments or checkouts (RLS). The fake provider and its dev routes are
  refused in production; Tap requires its secret key in production.
- Provider error bodies are never returned to clients.

### CRM (Phase 8)

- Every CRM table is tenant-owned with forced RLS; links between CRM records use composite
  `(id, organization_id)` foreign keys, so cross-tenant references fail at the database even
  if a service check were missed. Services additionally verify referenced records are live.
- Owners, assignees and `user` custom fields must be active members of the same organization.
- Search input is reduced to letters/digits/joiners before building `tsquery`; LIKE patterns
  escape wildcards. Global search covers only readable record types.
- Linked-record names are withheld from callers without read access to that record type;
  linking requires that read access.
- CSV: parser limits (5 MB, 10,000 rows, 60 columns, 10,000 characters per value), uploads
  accepted only on the import endpoint (the web proxy raises its body limit for that path
  only). Exports neutralize spreadsheet formulas (`=`, `+`, `-`, `@`, tab, CR prefixed with
  `'`), are audited on request and download, expire after 24 hours, are downloadable only by
  their creator and are rate limited (imports 20/h, exports 30/h, bulk 300/h per
  organization).
- Timeline (Phase 9): activity rows are filtered by their stored required permission and
  expose only allow-listed metadata keys; server-controlled fields (actor, permission, source
  event) cannot be supplied by clients; timelines of other tenants' records return 404;
  projection runs in tenant scope. Only manually logged entries can be deleted (audited).
- Notes are stored and rendered as plain text; website links render only normalized
  `http(s)` URLs with `rel="noopener noreferrer nofollow"`.

### Communications (Phase 10)

- Channel credentials are write-only (sealed, never returned, audited by field name only);
  members without `communications.manage` see only a channel's name, provider, address and
  status. Without credentials a channel is `configuration_required` and cannot send.
- Webhooks: an unguessable per-connection URL token (32 random bytes, stored as SHA-256,
  masked in logs, rotatable) selects the connection; the provider signature is then verified
  with that connection's own secret (constant-time comparison) before anything is parsed or
  stored. Unknown tokens → 404, bad signatures → 401. Events are deduplicated by provider id
  and processed in the connection's tenant (system scope only for the token lookup and the
  webhook event log). Status updates move forward only.
- Inbound content is stored and rendered as plain text; attachments are metadata only.
- Outbound: quota consumed once per message (idempotency key), WhatsApp's 24-hour rule
  enforced server-side, delivery via the `communications.send` job with retries for
  retryable provider errors only; provider error bodies are reduced to a code and a short
  message.
- The development simulator and fake providers are refused in production.

### Calendar & booking (Phase 11)

- Double booking is prevented by the database: every booking holds its time (with buffers)
  as busy blocks under an exclusion constraint; concurrent bookings are settled by the
  constraint, not by application checks (concurrency tests: 10 simultaneous bookings → 1).
- Public pages and manage links resolve their tenant by global slug / token hash (system
  scope, justified); everything else runs in that tenant. Public responses expose start times
  only (no host ids), are `no-store`, and are rate limited per IP (reads, bookings, manage
  actions) and per page (bookings). A honeypot field rejects naive bots; invitee input is
  validated (email, phone, IANA time zone) and stored and rendered as plain text.
- Manage links: 256-bit random tokens, SHA-256 stored, expire 30 days after the appointment,
  masked in request logs, `noindex` and `no-referrer` on the manage page. Each email carries
  its own token; invitees cannot bypass availability rules (staff-only `ignoreAvailability`).
- Staff bookings check that hosts and contacts belong to the organization (404 / 400);
  members edit only their own calendar unless they hold `calendar.manage`.
- External calendar credentials are sealed like channel credentials; a provider that cannot
  be read makes its host unavailable rather than looking free.

### Forms (Phase 12)

- Public forms resolve their tenant by global slug (system scope, justified); the submission
  runs in that tenant. Answers are validated against the version that was rendered: unknown
  keys are ignored, every value is type-checked and normalized (email, E.164 phone, decimal
  strings, calendar dates, allowed options only), lengths are bounded, and the body is capped
  at 64 KB / 100 keys.
- No mass assignment: submitters can only answer defined fields; fields can only feed an
  allow-listed set of contact properties or contact custom fields; owner, lifecycle stage,
  tags, deals, source and organization come from staff-defined settings (validated to be live
  records of the same organization at save and publish). Existing contacts are only completed
  (empty properties), never overwritten, so knowing someone's email does not let a stranger
  change their record. Deal value is never taken from a form.
- Spam: per-IP render and submit limits plus a per-form submit limit; a server-issued render
  token (256-bit, only its SHA-256 is stored in Redis, 24 h) proves the form was loaded, fixes
  the version, enforces a minimum fill time and makes double submits idempotent; a honeypot
  field; link-stuffing heuristics; optional captcha (Turnstile, verified server-side, fails
  closed). Suspected spam is stored as quarantined (no CRM changes, no event) and gets the
  same response as genuine submissions.
- Embeds: every page is `X-Frame-Options: DENY` / `frame-ancestors 'none'` except
  `/f/<slug>/embed`, whose `frame-ancestors` lists the form's allowed origins (strictly
  validated, re-validated by the web proxy, `'none'` on any doubt or API failure).
- Redirects after submission are staff-configured `https://` URLs without credentials.

### Automation (Phase 13)

- Runs execute in the worker in their tenant's scope; the scheduler that finds due runs is the
  only cross-tenant reader (system scope, justified) and executes each run in its own tenant.
  Workflows can only reference records of their organization (validated at save and publish),
  and events of one organization never start another's workflows.
- Idempotency: one run per (workflow, trigger occurrence) by a unique key, so redelivered
  events and webhook retries (`Idempotency-Key`) start one run; one step per (run, step) and
  each internal step commits atomically with its effects, so concurrent or repeated jobs never
  repeat an action. External calls are claimed with a lease and carry an `Idempotency-Key`
  header (at least once, deduplicated by the receiver).
- Loop protection (ADR-044): a workflow's own changes never start it again; chains of
  workflows starting each other stop at depth 3; at most 20 runs per workflow and contact per
  hour; steps form a tree (no cycles); runs time out after 90 days; plan quotas
  (`automation.workflows.max`, `automation.monthly_executions`).
- Webhook action (SSRF): https only, no credentials, no redirects, 10 s timeout, response
  discarded; every resolved address must be public (checked at connect time against DNS
  rebinding); BusinessOS's own hosts are refused. `AUTOMATION_ALLOW_PRIVATE_NETWORK` exists for
  development/tests and is refused in production.
- Inbound webhooks: 256-bit tokens stored as SHA-256, shown once, masked in logs, revoked on
  rotation and archiving; JSON objects ≤ 64 KB; rate limited per IP and per workflow.
- Templates only substitute plain values from allow-listed paths (no expressions); deal values
  are fixed by staff, never taken from trigger data.

## Review checklist (run every phase)

authentication · sessions · authorization · tenant isolation · IDOR · SQL injection · XSS ·
CSRF · SSRF · command injection · mass assignment · insecure redirects · webhook spoofing ·
replay · API keys · OAuth credentials · secret leakage · file uploads · brute force · rate
limiting · cache leakage · payment manipulation · AI prompt injection · AI tool abuse

## Findings log

| Date       | Phase | Severity | Finding                                                                                                                                                                                                  | Status                                                                         |
| ---------- | ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-10-05 | 13    | MEDIUM   | A workflow's webhook action could call BusinessOS itself (e.g. its own inbound webhook URL), a loop the run-chain depth cannot see (bounded only by rate limits and quotas). Found in phase review.      | Fixed: own hosts refused at save and send + regression test                    |
| 2026-10-05 | 13    | LOW      | Job ids for workflow runs and their messages contained `:`, which the queue rejects: runs would not have been queued in production (the test queue did not check). Found while wiring the API.           | Fixed: ids use `-`; the test queue enforces the production pattern             |
| 2026-10-05 | 12    | LOW      | Some form queries relied on RLS alone (no explicit `organization_id` filter), against the defense-in-depth rule. No exposure (RLS enforced). Found in phase review.                                      | Fixed: explicit filters on every forms query                                   |
| 2026-10-05 | 11    | MEDIUM   | Invitee manage-link tokens travel in URL paths and would have been written to request logs (same class as the Phase 10 webhook-token finding). Found in phase review before release.                     | Fixed: `redactUrlForLog` masks them + regression tests                         |
| 2026-10-05 | 10    | HIGH     | Request logs included full URLs, so per-connection webhook tokens (path) and WhatsApp `hub.verify_token` (query) would have been written to logs. Found in phase review before release.                  | Fixed: redacting `req` serializer (`redactUrlForLog`) + regression tests       |
| 2026-10-05 | 8     | MEDIUM   | Turborepo cache keys ignored internal package sources: lint/typecheck/test/build results could be replayed after a package change, so a regression could pass local gates.                               | Fixed: package sources in `globalDependencies` (ADR-031); full uncached re-run |
| 2026-10-05 | 8     | LOW      | Test isolation: one test file flushed the shared Redis test database, intermittently erasing other files' rate-limit counters (could mask or fake limiter behaviour).                                    | Fixed: no flushes; unique key prefixes per test context                        |
| 2026-10-05 | 8     | LOW      | A local Redis snapshot (`dump.rdb`, hashed test rate-limit counters only — no secrets or personal data) had been committed since Phase 0.                                                                | Fixed: untracked, `*.rdb` ignored                                              |
| 2026-10-05 | 3     | MEDIUM   | Web proxy forwarded client `X-Forwarded-For` unconditionally; a directly exposed web server would let clients spoof IPs to evade per-IP limits.                                                          | Fixed: opt-in `TRUST_PROXY_HEADERS`; API `TRUST_PROXY` accepts hops/CIDRs      |
| 2026-10-05 | 3     | LOW      | Authenticated API responses lacked `Cache-Control: no-store`.                                                                                                                                            | Fixed + test                                                                   |
| 2026-10-05 | 2     | HIGH     | Membership/organization RLS policies allowed a user's other-tenant rows to be visible inside a tenant context (user-scope clause applied in tenant scope). Caught by the isolation suite before release. | Fixed (migration 0003) + regression test                                       |

## Reporting

Security issues found during development are fixed before feature work continues and get a
regression test (see CLAUDE.md).
