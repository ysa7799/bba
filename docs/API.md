# API

One Fastify server (`apps/api`) exposes several surfaces:

| Prefix                          | Audience                            | Auth                              | Notes                                |
| ------------------------------- | ----------------------------------- | --------------------------------- | ------------------------------------ |
| `/health/live`, `/health/ready` | infrastructure                      | none                              | readiness checks Postgres + Redis    |
| `/app/*`                        | first-party web app                 | session cookie + origin check     | not a public contract                |
| `/app/orgs/:orgId/*`            | first-party, tenant-scoped          | session + membership + permission | `:orgId` is a selector only          |
| `/api/v1/*`                     | developers                          | API key (`Authorization: Bearer`) | versioned public contract (Phase 17) |
| `/webhooks/:provider/*`         | payment/messaging providers         | provider signature                | Phase 7/10                           |
| `/public/*`                     | anonymous visitors (forms, booking) | none, rate limited                | Phase 11/12                          |
| `/admin/*`                      | platform staff                      | platform-admin session            | Phase 24                             |

The web app reaches the API through its own `/api/*` rewrite (e.g. browser →
`/api/app/me` → API `/app/me`).

## Conventions

- JSON only; `content-type: application/json` required for bodies.
- Request validation with Zod; unknown body keys are stripped.
- IDs are UUID strings. Timestamps are ISO-8601 UTC strings.
- Money: `{ "amount": "12.500", "currency": "BHD" }` — decimal string, explicit currency.
- Every response carries `x-request-id`.

## Errors

```json
{ "error": { "code": "not_found", "message": "Contact not found", "requestId": "…" } }
```

| HTTP | code                                  | When                                                         |
| ---- | ------------------------------------- | ------------------------------------------------------------ |
| 400  | `validation_error` (with `details[]`) | invalid input                                                |
| 401  | `unauthenticated`                     | missing/invalid session or key                               |
| 403  | `forbidden`                           | authenticated but not permitted (same-tenant resources only) |
| 404  | `not_found`                           | missing **or in another tenant**                             |
| 409  | `conflict`                            | uniqueness / state conflicts                                 |
| 422  | `unprocessable`                       | semantically invalid (business rule)                         |
| 429  | `rate_limited`                        | rate limit exceeded (`retry-after` header)                   |
| 402  | `entitlement_exceeded`                | plan limit reached                                           |
| 502  | `provider_error`                      | upstream provider failed                                     |
| 500  | `internal_error`                      | unexpected; no details leaked                                |

## Pagination

Cursor-based for lists: `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor: string | null }`.
`limit` max 100. Cursors are opaque base64url-encoded keyset positions.

## Endpoints

### Authentication (`/app/auth`, Phase 3)

| Method | Path                            | Notes                                                                                    |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| POST   | `/app/auth/register`            | `{name,email,password,locale?}` → 202 always (no enumeration)                            |
| POST   | `/app/auth/verify-email`        | `{token}` → `{user}`                                                                     |
| POST   | `/app/auth/resend-verification` | `{email}` → 202 always                                                                   |
| POST   | `/app/auth/login`               | `{email,password}` → sets session cookie, `{user}`; 401 / 403 `email_not_verified` / 429 |
| POST   | `/app/auth/logout`              | revokes session, clears cookie → 204                                                     |
| POST   | `/app/auth/forgot-password`     | `{email}` → 202 always                                                                   |
| POST   | `/app/auth/reset-password`      | `{token,password}` → `{user}`; revokes all sessions                                      |

### Current user (`/app/me`)

| Method | Path                          | Notes                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| GET    | `/app/me`                     | `{user, organizations[], activeOrganizationId}`               |
| POST   | `/app/me/active-organization` | `{organizationId}` → 204 (membership re-verified)             |
| POST   | `/app/me/password`            | `{currentPassword,newPassword}` → 204; revokes other sessions |

### Organizations

| Method | Path                       | Notes                                                                |
| ------ | -------------------------- | -------------------------------------------------------------------- |
| GET    | `/app/orgs`                | organizations the user belongs to                                    |
| POST   | `/app/orgs`                | `{name,slug?,countryCode?,defaultCurrency?,timezone?,locale?}` → 201 |
| GET    | `/app/orgs/:orgId`         | `{organization, settings}` (members only, else 404)                  |
| GET    | `/app/orgs/:orgId/members` | `?limit&cursor&search`                                               |

### Organization administration (Phase 4)

| Method            | Path                                           | Permission              | Notes                                            |
| ----------------- | ---------------------------------------------- | ----------------------- | ------------------------------------------------ |
| PATCH             | `/app/orgs/:orgId`                             | `organization.update`   | name, country, currency, timezone, locale        |
| PATCH             | `/app/orgs/:orgId/settings`                    | `organization.update`   | registry keys only                               |
| GET               | `/app/orgs/:orgId/access`                      | member                  | own roles + effective permissions                |
| GET               | `/app/orgs/:orgId/permissions`                 | member                  | catalogue for the role editor                    |
| POST              | `/app/orgs/:orgId/leave`                       | member                  | 409 for the last owner                           |
| PUT               | `/app/orgs/:orgId/members/:membershipId/roles` | `settings.users.manage` | `{roleIds}`; escalation guards                   |
| PATCH             | `/app/orgs/:orgId/members/:membershipId`       | `settings.users.manage` | `{status}` suspend/reactivate                    |
| DELETE            | `/app/orgs/:orgId/members/:membershipId`       | `settings.users.manage` | remove member                                    |
| GET               | `/app/orgs/:orgId/roles`                       | member                  | roles with effective permissions + member counts |
| POST/PATCH/DELETE | `/app/orgs/:orgId/roles[/:roleId]`             | `settings.roles.manage` | custom roles only                                |
| GET/POST          | `/app/orgs/:orgId/invitations`                 | `settings.users.manage` | `{email, roleId}`                                |
| DELETE            | `/app/orgs/:orgId/invitations/:id`             | `settings.users.manage` | revoke                                           |

### Audit log (Phase 5)

| Method | Path                          | Permission   | Notes                                                    |
| ------ | ----------------------------- | ------------ | -------------------------------------------------------- |
| GET    | `/app/orgs/:orgId/audit-logs` | `audit.read` | `?limit&cursor&action&actorUserId&from&to`, newest first |

### Billing (Phase 6)

| Method  | Path                                    | Permission                | Notes                                                                |
| ------- | --------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| GET     | `/app/billing/plans`                    | signed in                 | public plans, latest published versions, prices `{amount, currency}` |
| GET     | `/app/orgs/:orgId/billing/entitlements` | member                    | resolved values, sources, usage (seats, monthly quotas)              |
| GET     | `/app/orgs/:orgId/billing/subscription` | `settings.billing.manage` | live subscription + plan                                             |
| GET/PUT | `/app/orgs/:orgId/billing/customer`     | `settings.billing.manage` | billing profile (audited)                                            |

There is intentionally no tenant endpoint that changes a subscription; plan changes arrive with
verified payments (Phase 7) or platform administration (Phase 24). Limit violations return
`402 entitlement_exceeded`.

### Invitations

| Method | Path                        | Notes                                                        |
| ------ | --------------------------- | ------------------------------------------------------------ |
| POST   | `/app/invitations/preview`  | `{token}` → invitation summary                               |
| POST   | `/app/invitations/accept`   | `{token}` (signed in; email must match) → `{organizationId}` |
| POST   | `/app/invitations/register` | `{token,name,password}` → new verified account + session     |

Session cookie: `__Host-bos_session` (production; `bos_session` in development), HttpOnly,
Secure, SameSite=Lax, absolute 30-day lifetime, 7-day idle timeout. All `/app/*` responses are
`Cache-Control: no-store`.
