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

### Payments (Phase 7)

| Method | Path                                           | Permission                | Notes                                                                       |
| ------ | ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| GET    | `/app/billing/payments-config`                 | signed in                 | provider, status (`ready` / `configuration_required` / `disabled`), methods |
| POST   | `/app/orgs/:orgId/billing/checkout`            | `settings.billing.manage` | `{priceId, method?}` → `{checkoutId, paymentId, redirectUrl}`               |
| GET    | `/app/orgs/:orgId/billing/checkout/:id`        | `settings.billing.manage` | checkout + payment status                                                   |
| POST   | `/app/orgs/:orgId/billing/checkout/:id/verify` | `settings.billing.manage` | server re-fetches from the provider; client parameters ignored              |
| GET    | `/app/orgs/:orgId/billing/payments`            | `settings.billing.manage` | payment history                                                             |
| POST   | `/webhooks/payments/:provider`                 | provider signature        | raw body; 401 invalid signature; `{received, outcome}`                      |
| POST   | `/app/dev/payments/fake/:id/complete`          | creator of the payment    | development only (fake provider, non-production)                            |

### CRM (Phase 8)

All under `/app/orgs/:orgId/crm`. Lists return `{ data, nextCursor }` (keyset cursors are tied to
the sort); single records return `{ contact }`, `{ company }`, `{ deal }`, … Deletes return 204.

| Method                      | Path                                                                | Permission                                                     | Notes                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET                         | `/contacts`                                                         | `crm.contact.read`                                             | `q, ownerUserId (uuid/me/none), lifecycleStage, status, source, tagId, companyId, createdFrom, createdTo, cf.<key>, sort, limit, cursor` |
| POST                        | `/contacts`                                                         | `crm.contact.create` (+ `crm.company.read` to set `companyId`) | phones normalized to E.164 in the organization country; 409 on duplicate email                                                           |
| GET / PATCH / DELETE        | `/contacts/:id`                                                     | read / `crm.contact.update` / `crm.contact.delete`             | soft delete (audited)                                                                                                                    |
| POST                        | `/contacts/bulk`                                                    | update (delete for `delete`)                                   | `{action, ids ≤ 500, …}`: delete, assign_owner, add_tags, remove_tags, set_lifecycle, set_status → `{affected}`                          |
| POST / DELETE               | `/contacts/:id/companies[/:companyId]`                              | `crm.contact.update` + `crm.company.read`                      | link with role and primary flag                                                                                                          |
| GET / POST / …              | `/companies…`                                                       | `crm.company.*`                                                | same shape as contacts; filters `q, ownerUserId, industry, countryCode, tagId, cf.<key>`                                                 |
| GET / POST                  | `/pipelines`                                                        | `crm.deal.read` / `crm.pipeline.manage`                        | default pipeline created on first read                                                                                                   |
| PATCH / DELETE              | `/pipelines/:id`                                                    | `crm.pipeline.manage`                                          | rename, make default; DELETE archives (no open deals, not default)                                                                       |
| POST / PATCH / DELETE       | `/pipelines/:id/stages[/:stageId]`                                  | `crm.pipeline.manage`                                          | kind open/won/lost; structural guards                                                                                                    |
| PUT                         | `/pipelines/:id/stages/order`                                       | `crm.pipeline.manage`                                          | `{stageIds}` (complete permutation)                                                                                                      |
| GET                         | `/pipelines/:id/board`                                              | `crm.deal.read`                                                | stages with ordered deals, counts and per-currency totals                                                                                |
| GET / POST                  | `/deals`                                                            | `crm.deal.read` / `crm.deal.create`                            | value `{amount, currency}`; filters `pipelineId, stageId, status, ownerUserId, contactId, companyId, tagId, q, cf.<key>`                 |
| GET / PATCH / DELETE        | `/deals/:id`                                                        | `crm.deal.*`                                                   | stage changes through PATCH or move                                                                                                      |
| POST                        | `/deals/:id/move`                                                   | `crm.deal.update`                                              | `{stageId, pipelineId?, afterDealId?, beforeDealId?, lostReason?}`                                                                       |
| POST                        | `/deals/bulk`                                                       | update / delete                                                | delete, assign_owner, add_tags, remove_tags                                                                                              |
| GET / POST                  | `/{contacts,companies,deals}/:id/notes`                             | parent read / + `crm.note.create`                              | plain text                                                                                                                               |
| PATCH / DELETE              | `/notes/:id`                                                        | author with `crm.note.create`, or `crm.note.manage`            | parent read access required                                                                                                              |
| GET / POST                  | `/tasks`                                                            | `crm.task.read` / `crm.task.manage`                            | `status, assigneeUserId, due (overdue/today/upcoming/none), contactId, companyId, dealId, q, sort`                                       |
| GET / PATCH / DELETE        | `/tasks/:id`                                                        | `crm.task.*`                                                   | `status: completed` emits `task.completed`                                                                                               |
| GET / POST / PATCH / DELETE | `/tags[/:id]`                                                       | any CRM read / `crm.tag.manage`                                | deleting a tag removes it from all records (audited)                                                                                     |
| GET / POST / PATCH          | `/custom-fields[/:id]`                                              | any CRM read / `crm.custom_field.manage`                       | key, type and record type are immutable; `archived: true` hides                                                                          |
| GET                         | `/assignees`, `/search?q=`                                          | any CRM read                                                   | active members (id, name); cross-record search limited to readable types                                                                 |
| GET / POST                  | `/imports`                                                          | `crm.data.import` + create/update of the type                  | `{entityType, fileName, content}` (CSV ≤ 5 MB, ≤ 10,000 rows) → staged import                                                            |
| GET / PATCH                 | `/imports/:id`                                                      | same                                                           | detail with fields, sample rows and row errors; PATCH `{mapping, duplicatePolicy}`                                                       |
| GET / POST                  | `/imports/:id/preview`, `/imports/:id/start`, `/imports/:id/cancel` | same                                                           | start queues `crm.import` (idempotent while queued)                                                                                      |
| GET / POST                  | `/exports`                                                          | `crm.data.export` + read of the type                           | own exports; POST `{entityType, filters}` → 202                                                                                          |
| GET                         | `/exports/:id`, `/exports/:id/download`                             | same; creator only                                             | CSV attachment, `no-store`, audited                                                                                                      |

### Activity timeline (Phase 9)

| Method | Path                                                           | Permission                         | Notes                                                                                                                                                   |
| ------ | -------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/app/orgs/:orgId/crm/{contacts,companies,deals}/:id/timeline` | read on the record                 | `?category=note\|task\|deal\|communication\|record&from&to&limit&cursor`, newest first                                                                  |
| GET    | `/app/orgs/:orgId/crm/activities`                              | any CRM read                       | organization feed                                                                                                                                       |
| POST   | `/app/orgs/:orgId/crm/activities`                              | `crm.activity.log` + read on links | `{type: call/meeting/email/whatsapp/sms.logged, summary, details?, direction?, durationMinutes?, outcome?, occurredAt?, contactId?/companyId?/dealId?}` |
| DELETE | `/app/orgs/:orgId/crm/activities/:id`                          | author or `crm.activity.manage`    | logged activities only (audited)                                                                                                                        |

Every row is filtered by the permission it requires; `metadata` contains only the keys its type
declares.

### Communications (Phase 10)

All under `/app/orgs/:orgId/communications`.

| Method | Path                           | Permission                                 | Notes                                                                                                                                     |
| ------ | ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/conversations`               | `communications.read`                      | `status (open/closed/all), assignee (uuid/me/none/all), channel, unread, q, contactId, tagId, limit, cursor`; newest activity first       |
| GET    | `/conversations/unread-count`  | `communications.read`                      | `{unread}` open conversations with unread messages                                                                                        |
| POST   | `/conversations`               | `communications.send` + `crm.contact.read` | `{connectionId, contactId, subject?}` → 201 new / 200 existing; address taken from the contact for the channel                            |
| GET    | `/conversations/:id`           | `communications.read`                      | contact shown only with `crm.contact.read`; `canReplyFreely` (WhatsApp 24-hour window)                                                    |
| GET    | `/conversations/:id/messages`  | `communications.read`                      | newest first, keyset paged; internal notes included                                                                                       |
| POST   | `/conversations/:id/messages`  | `communications.send`                      | `{text, subject?}` or `{template: {name, language, parameters}}` → 202, queued for `communications.send`; 409 outside the WhatsApp window |
| POST   | `/conversations/:id/notes`     | `communications.send`                      | `{text}` internal note (never sent)                                                                                                       |
| POST   | `/conversations/:id/read`      | `communications.read`                      | resets the unread count → 204                                                                                                             |
| PATCH  | `/conversations/:id`           | `communications.assign`                    | `{assigneeUserId?, status?, tagIds?}`; assignee must be an active member                                                                  |
| GET    | `/templates`                   | `communications.read`                      | approved WhatsApp templates, `?connectionId`                                                                                              |
| GET    | `/channels`                    | `communications.read`                      | public fields; with `communications.manage` also configured fields, non-secret credential values, settings and errors (never secrets)     |
| GET    | `/channels/providers`          | `communications.manage`                    | providers with credential fields; `encryptionConfigured`                                                                                  |
| POST   | `/channels`                    | `communications.manage`                    | `{provider, name, address, externalAccountId?, credentials?, settings?}` → 201 `{connection, webhookUrl}` (URL shown once; audited)       |
| PATCH  | `/channels/:id`                | `communications.manage`                    | `{name?, credentials? (replaces given fields), settings?}` (audited, field names only)                                                    |
| POST   | `/channels/:id/rotate-webhook` | `communications.manage`                    | new `{webhookUrl}`; the old one stops working (audited)                                                                                   |
| DELETE | `/channels/:id`                | `communications.manage`                    | disconnect: credentials wiped, conversations kept (audited)                                                                               |
| POST   | `/channels/:id/templates`      | `communications.manage`                    | `{name, language, category, body}` register an approved WhatsApp template (audited)                                                       |

Provider callbacks (no session; authenticity per provider, see `INTEGRATIONS.md`):

| Method | Path                                        | Notes                                                                               |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST   | `/webhooks/communications/:provider/:token` | raw body; 404 unknown token, 401 bad signature, 200 `{received: true}` (idempotent) |
| GET    | `/webhooks/communications/:provider/:token` | subscription handshake (WhatsApp `hub.challenge`); 404 otherwise                    |

Development only (`COMMUNICATIONS_FAKE_PROVIDERS=true`, never in production; `communications.manage`):
`POST /app/dev/communications/:orgId/channels/:id/inbound` `{from, fromName?, subject?, text}`
and `/status` `{messageId, status}` sign a fake-provider payload and run it through the real
webhook pipeline.

### Calendar & booking (Phase 11)

All under `/app/orgs/:orgId/calendar`. Times are ISO 8601 instants; availability rules are
minutes after local midnight in the calendar's IANA time zone.

| Method               | Path                                       | Permission                                                           | Notes                                                                                                                                                                   |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                  | `/calendars`                               | `calendar.appointment.read`                                          | personal (`user`) and shared (`resource`) calendars                                                                                                                     |
| POST                 | `/calendars/me`                            | `calendar.appointment.manage`                                        | the caller's personal calendar, created on first use with the local working week (Sun–Thu in BH/SA/KW/QA/OM, Mon–Fri elsewhere) 09:00–17:00                             |
| POST                 | `/calendars`                               | `calendar.manage`                                                    | `{name, timezone?}` shared calendar (audited)                                                                                                                           |
| GET / PATCH          | `/calendars/:id`                           | read / own calendar or `calendar.manage` (`isActive`: manage)        | `{name?, timezone?, isActive?}` (audited)                                                                                                                               |
| GET / PUT            | `/calendars/:id/availability`              | read / own calendar or `calendar.manage`                             | PUT `{rules: [{weekday 0–6, startMinute, endMinute}]}` replaces weekly hours (no overlaps)                                                                              |
| POST / DELETE        | `/calendars/:id/exceptions[/:exceptionId]` | own calendar or `calendar.manage`                                    | `{date, kind: available\|unavailable, startMinute?, endMinute?, reason?}`; `available` = custom hours for that day                                                      |
| GET                  | `/calendar-providers`                      | `calendar.appointment.manage`                                        | providers with credential fields; `encryptionConfigured`                                                                                                                |
| GET / POST           | `/calendars/:id/connections`               | own calendar or `calendar.manage`                                    | `{provider, externalCalendarId, credentials?, checkConflicts?, writeEvents?}`; secrets are write-only (audited)                                                         |
| DELETE               | `/calendar-connections/:id`                | own calendar or `calendar.manage`                                    | disconnect; credentials wiped (audited)                                                                                                                                 |
| GET / POST           | `/appointment-types`                       | read / `calendar.manage`                                             | `{name, slug?, durationMinutes, buffer*, slotIntervalMinutes, minimumNoticeMinutes, maximumAdvanceDays, schedulingMode, locationKind, hostCalendarIds}` (audited)       |
| GET / PATCH          | `/appointment-types/:id`                   | read / `calendar.manage`                                             | deactivate with `isActive: false` (types are never deleted)                                                                                                             |
| GET                  | `/appointment-types/:id/slots`             | `calendar.appointment.read`                                          | `?from&to` (≤ 31 days) → `[{startsAt, calendarIds}]` free starts with the free hosts                                                                                    |
| GET / POST           | `/booking-pages`                           | read / `calendar.manage`                                             | `{title, slug?, description?, appointmentTypeIds, isActive}`; slugs are global (a taken one gets a random suffix) (audited)                                             |
| GET / PATCH / DELETE | `/booking-pages/:id`                       | read / `calendar.manage`                                             | DELETE only for pages without bookings (409 otherwise: deactivate instead) (audited)                                                                                    |
| GET                  | `/appointments`                            | `calendar.appointment.read`                                          | `?from&to&calendarId&contactId&status (scheduled default, all)&limit&cursor`, by start time                                                                             |
| GET                  | `/appointments/:id`                        | `calendar.appointment.read`                                          | contact name only with `crm.contact.read`                                                                                                                               |
| POST                 | `/appointments`                            | `calendar.appointment.manage` (+ `crm.contact.read` for `contactId`) | type booking `{appointmentTypeId, startsAt, calendarId?}` or ad hoc `{calendarId, title, durationMinutes, startsAt}`; `invitee`, `ignoreAvailability` → 201 / 409 taken |
| POST                 | `/appointments/:id/cancel`                 | `calendar.appointment.manage`                                        | `{reason?}`; frees the time                                                                                                                                             |
| POST                 | `/appointments/:id/reschedule`             | `calendar.appointment.manage`                                        | `{startsAt, ignoreAvailability?}` in place; 409 when taken (appointment unchanged)                                                                                      |
| POST                 | `/appointments/:id/status`                 | `calendar.appointment.manage`                                        | `{status: completed\|no_show}` after the start                                                                                                                          |

Changes email the invitee (when there is one) through `email.send` and queue `calendar.sync`.

Public booking (no session; rate limited per IP and per page; `Cache-Control: no-store`):

| Method | Path                                                  | Notes                                                                                                                                                                   |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/public/booking/pages/:slug`                         | active page: title, organization name and time zone, offered types                                                                                                      |
| GET    | `/public/booking/pages/:slug/types/:typeId/slots`     | `?from&to` → ISO start times only (hosts are not revealed)                                                                                                              |
| POST   | `/public/booking/pages/:slug/book`                    | `{appointmentTypeId, startsAt, invitee: {name, email, phone?, notes?, timezone}, website (honeypot, must be empty)}` → 201 `{appointment, manageToken}`; 409 when taken |
| GET    | `/public/booking/manage/:token`                       | the invitee's view (no staff data)                                                                                                                                      |
| GET    | `/public/booking/manage/:token/slots`                 | times to move to (same type and rules)                                                                                                                                  |
| POST   | `/public/booking/manage/:token/cancel`, `/reschedule` | `{reason?}` / `{startsAt}`                                                                                                                                              |

### Invitations

| Method | Path                        | Notes                                                        |
| ------ | --------------------------- | ------------------------------------------------------------ |
| POST   | `/app/invitations/preview`  | `{token}` → invitation summary                               |
| POST   | `/app/invitations/accept`   | `{token}` (signed in; email must match) → `{organizationId}` |
| POST   | `/app/invitations/register` | `{token,name,password}` → new verified account + session     |

Session cookie: `__Host-bos_session` (production; `bos_session` in development), HttpOnly,
Secure, SameSite=Lax, absolute 30-day lifetime, 7-day idle timeout. All `/app/*` responses are
`Cache-Control: no-store`.
