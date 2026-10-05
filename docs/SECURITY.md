# Security

Security and tenant isolation are the top two engineering priorities. This document is the
threat model and the control catalogue; it is updated whenever a control is added.

## Threat model (summary)

| Asset | Main threats | Primary controls |
| --- | --- | --- |
| Tenant data | Cross-tenant reads/writes, IDOR, search leakage | Membership-based tenant resolution, explicit org filters, Postgres RLS, isolation tests |
| Accounts | Credential stuffing, session theft, reset-token abuse | argon2id, rate limits, opaque hashed session tokens, httpOnly cookies, single-use expiring tokens |
| Authorization | Privilege escalation, role tampering | Server-side permission checks, role-assignment rules (cannot grant above own level), audit |
| Payments | Forged success, replayed webhooks, amount tampering | Server-side verification, signed webhooks, idempotency, server-computed totals |
| Integrations | Token theft, credential leakage | Envelope encryption at rest, never sent to browser, scoped access |
| Platform | SSRF via webhooks/HTTP actions, host-header attacks, XSS, CSRF | URL allow/deny rules, private-IP blocking, host allow-list, CSP, SameSite + origin checks |
| AI | Prompt injection → tool abuse | Tools run with the user's permissions, input validation, approval for high-risk actions |

## Controls

### Tenant isolation
- Organization is the tenant; every tenant row carries `organization_id`.
- Three layers (request → repository → RLS); see `ARCHITECTURE.md §3`.
- Resources in another organization return **404**, never 403, so IDs cannot be probed.
- Client-supplied foreign keys are re-validated inside the tenant.
- Mandatory isolation tests per resource: read, list, search, update, delete, reference,
  guessed-ID probing.

### Authentication _(Phase 3)_
- Passwords: argon2id (memory-hard), min length 10, max 256, breached-pattern checks later.
- Sessions: 256-bit random opaque token in `__Host-`/httpOnly/Secure/SameSite=Lax cookie; only
  the SHA-256 hash is stored. Idle + absolute expiry; rotation on privilege change; revocation
  on password reset.
- Email verification, password reset, invitations: single-use, hashed, short-lived tokens.
- Login responses do not reveal whether an email exists. Constant-time comparisons.
- Prepared for OAuth (Google, Microsoft), MFA (TOTP/WebAuthn), passkeys, SAML via an
  `identities` table separate from `users`.

### CSRF
- Session cookies are `SameSite=Lax`; all state-changing first-party requests must carry a
  matching `Origin` (or `Referer`) from the allow-list, and JSON content type.

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
- Integration credentials encrypted (AES-256-GCM, key from `ENCRYPTION_KEY`, key id stored
  for rotation).
- API keys: shown once, stored as SHA-256 hash with prefix for lookup.
- Log redaction for `password`, `token`, `authorization`, `cookie`, `secret`, `apiKey`, etc.

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

## Review checklist (run every phase)

authentication · sessions · authorization · tenant isolation · IDOR · SQL injection · XSS ·
CSRF · SSRF · command injection · mass assignment · insecure redirects · webhook spoofing ·
replay · API keys · OAuth credentials · secret leakage · file uploads · brute force · rate
limiting · cache leakage · payment manipulation · AI prompt injection · AI tool abuse

## Findings log

| Date | Phase | Severity | Finding | Status |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## Reporting

Security issues found during development are fixed before feature work continues and get a
regression test (see CLAUDE.md).
