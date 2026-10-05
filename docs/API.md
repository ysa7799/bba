# API

One Fastify server (`apps/api`) exposes several surfaces:

| Prefix | Audience | Auth | Notes |
| --- | --- | --- | --- |
| `/health/live`, `/health/ready` | infrastructure | none | readiness checks Postgres + Redis |
| `/app/*` | first-party web app | session cookie + origin check | not a public contract |
| `/app/orgs/:orgId/*` | first-party, tenant-scoped | session + membership + permission | `:orgId` is a selector only |
| `/api/v1/*` | developers | API key (`Authorization: Bearer`) | versioned public contract (Phase 17) |
| `/webhooks/:provider/*` | payment/messaging providers | provider signature | Phase 7/10 |
| `/public/*` | anonymous visitors (forms, booking) | none, rate limited | Phase 11/12 |
| `/admin/*` | platform staff | platform-admin session | Phase 24 |

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

| HTTP | code | When |
| --- | --- | --- |
| 400 | `validation_error` (with `details[]`) | invalid input |
| 401 | `unauthenticated` | missing/invalid session or key |
| 403 | `forbidden` | authenticated but not permitted (same-tenant resources only) |
| 404 | `not_found` | missing **or in another tenant** |
| 409 | `conflict` | uniqueness / state conflicts |
| 422 | `unprocessable` | semantically invalid (business rule) |
| 429 | `rate_limited` | rate limit exceeded (`retry-after` header) |
| 402 | `entitlement_exceeded` | plan limit reached |
| 502 | `provider_error` | upstream provider failed |
| 500 | `internal_error` | unexpected; no details leaked |

## Pagination

Cursor-based for lists: `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor: string | null }`.
`limit` max 100. Cursors are opaque base64url-encoded keyset positions.

## Endpoints

Documented per module as they land.
