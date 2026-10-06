# Integrations

## Principles

- Every provider sits behind a port (interface) with declared **capabilities**; domains use
  normalized types only. Provider-specific code lives in its adapter.
- Each port ships a **fake adapter** used in tests and local development.
- Without credentials, a live adapter reports `CONFIGURATION_REQUIRED` — never pretends to work.
- Credentials are encrypted at rest (AES-256-GCM, versioned key id) and never sent to the
  browser. Only status and non-secret metadata are exposed.
- Inbound webhooks: verify authenticity → resolve tenant → normalize → dedupe → process
  idempotently (see `SECURITY.md`).

## Ports (planned)

| Port               | Phase | First adapters                                                          | Live status            |
| ------------------ | ----- | ----------------------------------------------------------------------- | ---------------------- |
| `PaymentProvider`  | 7     | Tap Payments, Fake (implemented)                                        | CONFIGURATION_REQUIRED |
| `ChannelProvider`  | 10    | Postmark (email), WhatsApp Cloud API, Twilio (SMS), Fakes (implemented) | CONFIGURATION_REQUIRED |
| `FileStorage`      | 16    | S3-compatible (SigV4), local disk (dev), Memory (tests) (implemented)   | CONFIGURATION_REQUIRED |
| `CalendarProvider` | 11/18 | Google Calendar, Microsoft 365, Fake (implemented)                      | CONFIGURATION_REQUIRED |
| `OAuthProvider`    | 18    | Google, Microsoft 365, Fake (implemented)                               | CONFIGURATION_REQUIRED |
| `AIProvider`       | 20    | Anthropic-compatible, Fake                                              | CONFIGURATION_REQUIRED |
| `CaptchaVerifier`  | 12    | Cloudflare Turnstile, Fake (implemented)                                | CONFIGURATION_REQUIRED |

## Tap Payments (Phase 7)

- Adapter: `packages/payments/src/providers/tap.ts`. Endpoints `POST /v2/charges`,
  `GET /v2/charges/:id`, `POST /v2/refunds`; `Authorization: Bearer <secret key>`; amounts sent
  as decimals with the currency's exponent (BHD = 3); `source.id` `src_all`, `src_card` or
  `src_bh.benefit`; `redirect.url` (return page) and `post.url` (webhook).
- Webhook authenticity: `hashstring` header = HMAC-SHA256(secret key) over
  `x_id…x_amount…x_currency…x_gateway_reference…x_payment_reference…x_status…x_created…`.
  Webhooks are hints only: the service always re-fetches the charge.
- Status mapping: CAPTURED→captured, AUTHORIZED→authorized, INITIATED→requires_action,
  FAILED/DECLINED/RESTRICTED/TIMEDOUT→failed, ABANDONED/CANCELLED/VOID→canceled, unknown→pending.
- Configuration: `PAYMENTS_PROVIDER=tap`, `TAP_SECRET_KEY`, optional `TAP_API_BASE_URL`,
  `API_PUBLIC_URL` (webhook host). Live status: **CONFIGURATION_REQUIRED** — field names and the
  hash recipe follow Tap's public documentation and must be validated in the Tap sandbox.
- Refund notifications are acknowledged but not yet processed (refund status is read on sync).

## Messaging channels (Phase 10)

One port, `ChannelProvider` (`packages/communications/src/types.ts`), for email, WhatsApp and
SMS: `send(connection, message)` → `{providerMessageId, status}`, `parseWebhook(connection,
request)` → normalized `message` / `status` events (throws `WebhookSignatureError` when the
request is not authentic), optional `verifySubscription` for GET handshakes. Each provider
declares its `credentialFields` (secret or not) and whether it needs an external account id.

Tenants connect their own provider accounts under **Inbox → Channels** (`communications.manage`).
Credentials are sealed with the platform `SecretBox` (AES-256-GCM, key id in the ciphertext,
associated data `channel_connection:<org>:<id>`) and are write-only: the API returns which fields
are configured and the values of non-secret fields only. A channel without credentials is
`configuration_required` and cannot send.

Each connection gets an unguessable webhook URL
`{API_PUBLIC_URL}/webhooks/communications/<provider>/<token>` (32 random bytes; only a SHA-256
hash is stored, and the token is masked in logs). It is shown once when the channel is created
and whenever it is rotated (rotation invalidates the old URL immediately). The token selects the
connection, then the provider's own signature check runs with that connection's credentials;
events are deduplicated by provider id and processed in the connection's tenant.

| Provider                                          | Credentials (secret ✱)                                   | Account id        | Webhook authenticity                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postmark (`postmark`, email)                      | Server API token ✱, webhook username, webhook password ✱ | —                 | HTTP Basic credentials embedded in the webhook URL (`https://user:pass@…`) for the inbound and delivery webhooks                                                                                                                 |
| WhatsApp Cloud API (`whatsapp_cloud`)             | Access token ✱, app secret ✱, webhook verify token ✱     | `phone_number_id` | `X-Hub-Signature-256` = HMAC-SHA256(app secret, raw body); GET `hub.challenge` handshake checks the verify token                                                                                                                 |
| Twilio SMS (`twilio`)                             | Account SID, auth token ✱                                | —                 | `X-Twilio-Signature` = Base64 HMAC-SHA1(auth token, full URL + sorted POST params). The URL must equal the one configured in Twilio, so `API_PUBLIC_URL` must be the exact public origin (no proxy rewriting of scheme or host). |
| Fakes (`fake_email`, `fake_whatsapp`, `fake_sms`) | optional webhook secret (generated)                      | —                 | `x-fake-signature` HMAC-SHA256; development and tests only (`COMMUNICATIONS_FAKE_PROVIDERS=true`, refused in production)                                                                                                         |

### Setup

- **Postmark:** create a server, verify the sending domain/signature for the channel address,
  copy the Server API token. Set the inbound webhook (and delivery/bounce webhooks) to the
  channel's webhook URL with `username:password@` added to the host, using the webhook username
  and password saved on the channel. Transactional platform email (verification, invitations)
  uses `EMAIL_TRANSPORT=postmark` with `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM` in the worker.
- **WhatsApp Cloud API:** in the Meta app, add WhatsApp, note the phone number id (account id)
  and a permanent system-user access token; copy the app secret. Configure the webhook callback
  URL with the channel's verify token and subscribe to `messages`. Outside the 24-hour customer
  service window only approved templates can be sent: register each approved template on the
  channel (name, language, category, body with `{{1}}` variables).
- **Twilio:** use the account SID and auth token, set the number's (or Messaging Service's)
  incoming message webhook and status callback to the channel's webhook URL (HTTP POST). The
  channel address is the sending number (E.164), alphanumeric sender id or `MG…` service SID.

Live status: **CONFIGURATION_REQUIRED** for all three. Request/response field names follow each
provider's public documentation and are covered by contract tests with recorded payloads; they
must be validated against a sandbox account before go-live. Attachments are recorded as
metadata only (download/storage arrives with the files service, Phase 16).

## External calendars (Phase 11)

`CalendarProvider` (`packages/calendar/src/providers/types.ts`): `busyTimes(connection, range)`,
`createEvent(connection, event)` → `{externalEventId, joinUrl}`, `cancelEvent`. A host connects
an external calendar to one of our calendars (`calendar_connections`, credentials sealed with
the platform `SecretBox`). Busy times are read on demand when availability is computed (5 s
timeout; an unreadable calendar makes that host unavailable). Bookings are mirrored by the
`calendar.sync` job (created, recreated after a reschedule, removed on cancel; idempotent per
appointment and connection).

| Provider                             | Credentials          | Busy times                                                             | Events                                                                       |
| ------------------------------------ | -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Google Calendar (`google_calendar`)  | OAuth access token ✱ | `POST /calendar/v3/freeBusy`                                           | `events.insert` with `conferenceData` (Google Meet link for video bookings)  |
| Microsoft 365 (`microsoft_calendar`) | OAuth access token ✱ | Graph `POST /me/calendar/getSchedule` (mailbox address as calendar id) | Graph `POST /me/events` with `transactionId` (Teams link for video bookings) |
| Fake (`fake_calendar`, dev/tests)    | —                    | set by tests                                                           | in memory                                                                    |

Live status: **CONFIGURATION_REQUIRED** until the platform's Google and Microsoft OAuth clients
are configured (see "Connected accounts" below). With them, members choose **Connect with
Google / Microsoft 365** on a calendar: the connection uses their connected account and its
tokens are refreshed automatically. Pasting an access token still works but only until it
expires. Zoom meetings are not offered yet; video links come from the calendar providers
(Meet, Teams) or the type's location text.

## Invoice payments (Phase 14)

- Customers pay the **organization**, through the organization's own provider account
  (`commerce_payment_connections`), never through BusinessOS's billing account. Owners connect
  a provider under Invoicing setup; Tap needs the account's secret key (`sk_test_…` /
  `sk_live_…`), stored sealed. Without it the connection is **CONFIGURATION_REQUIRED** and
  invoices simply show no Pay button.
- The adapter is created per connection from its credentials (same `PaymentProvider` port and
  Tap adapter as Phase 7). Each checkout passes the connection's notification URL
  (`/webhooks/commerce/<connectionId>`) as `post.url`, so no dashboard setup is needed; the
  signature is checked with that connection's key and the charge is always re-fetched.
- Refunds go through the provider with the refund id as idempotency key; provider-side
  refunds made outside BusinessOS are detected on sync and logged for reconciliation (the
  invoice ledger is not rewritten silently).
- Development and tests: `COMMERCE_FAKE_PAYMENTS=true` adds the in-process fake provider
  ("Test payments") with a hosted-page stand-in at `/dev/fake-invoice-checkout` (web
  `ENABLE_DEV_PAYMENTS=true`); both are refused or hidden in production.

## Workflow webhooks (Phase 13)

- **Outbound** (`http.request` step): `POST` JSON `{workflowId, runId, trigger: {type, data},
contact?, deal}` with `Idempotency-Key: <runId>:<step>`, `X-BusinessOS-Workflow-Id` and
  `X-BusinessOS-Run-Id`. 2xx is success; 408/429/5xx and network errors are retried after 1, 5
  and 30 minutes; other answers fail the run. These requests are not signed — receivers should
  use an unguessable URL. For signed event notifications use webhook endpoints (Phase 17,
  below); signing workflow steps is a follow-up.
- **Inbound** (`webhook.received` trigger): `POST /webhooks/automation/<token>` with a JSON
  object; the body is available to steps as `{{trigger.body.<field>}}`. Send an
  `Idempotency-Key` header to make retries safe.

## Captcha for public forms (Phase 12)

`CaptchaVerifier` (`packages/forms/src/spam.ts`): `verify(token, remoteIp)`. Cloudflare
Turnstile is verified server-side (`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`,
5 s timeout); an unreachable provider fails closed (502, the visitor can retry). The browser
only receives the public site key.

Setup: create a Turnstile widget for the web app's domain, then set `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` on the API (both or neither). Until then captcha is
**CONFIGURATION_REQUIRED**: the builder shows it as unavailable and forms cannot require it;
every form still has rate limits, render tokens, a minimum fill time and a honeypot.
`FORMS_FAKE_CAPTCHA=true` (development/tests, refused in production) accepts the token `pass`.

## File storage (Phase 16)

`FileStorage` (`packages/files`) has three adapters: `S3FileStorage` for any S3-compatible
store (AWS S3, Cloudflare R2, MinIO, Wasabi…) with dependency-free SigV4 request signing
(verified against AWS's published example), `LocalFileStorage` for development (refused in
production) and `MemoryFileStorage` for tests. Without a bucket and keys the S3 adapter reports
`CONFIGURATION_REQUIRED` and uploads fail with a provider error instead of pretending to work.

### Setup

1. Create a private bucket (no public access; BusinessOS serves every download itself) in the
   region closest to your users (e.g. `me-south-1` Bahrain).
2. Create an access key limited to `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
   that bucket.
3. Set `FILES_STORAGE=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY` (and `S3_ENDPOINT` for non-AWS providers) on the API **and** the
   worker. The keys stay server-side.

## Outbound webhooks (Phase 17)

Customers add endpoints under **API & webhooks**; BusinessOS posts signed JSON for the event
types they choose (format, headers, signature verification and retry schedule in `API.md`).
Deliveries run in the worker on their own `webhooks` queue so slow customer servers cannot
delay email or automation. Every attempt is recorded (status, response code, duration, error)
and can be resent. No provider credentials are involved; endpoints are customer-owned URLs
held to the same SSRF rules as workflow webhook actions.

## Connected accounts — OAuth (Phase 18)

`@businessos/integrations` connects accounts at external providers through the OAuth 2.0
authorization-code flow with PKCE (S256) and a confidential client.

States: `connecting → active → (refresh_required | error) → active | disconnected`.
`refresh_required` means the provider refused the refresh token (revoked or expired grant) and
only the member reconnecting fixes it; `error` is a temporary failure that clears itself on the
next successful refresh.

Each account records: provider, organization, the member who connected it, the provider's
account id and label (email), granted scopes, sealed tokens (access + refresh), access-token
expiry, last refresh and use, last error and a failure count.

| Provider         | Key          | Endpoints                                                                                      | Calendar scopes                                             | Live status                                        |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Google           | `google`     | `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, OpenID userinfo, revoke | `openid email calendar.events calendar.freebusy`            | CONFIGURATION_REQUIRED without a client            |
| Microsoft 365    | `microsoft`  | `login.microsoftonline.com/<tenant>/oauth2/v2.0/*`, Graph `/me`                                | `openid email offline_access User.Read Calendars.ReadWrite` | CONFIGURATION_REQUIRED without a client            |
| Test (dev/tests) | `fake_oauth` | consent page `/dev/fake-oauth` in the web app; in-process token exchange                       | —                                                           | development and tests only (refused in production) |

Flow: the member starts from a calendar (`POST …/integrations/oauth/start`); the API records the
state (SHA-256 only) and the PKCE verifier (sealed) for 10 minutes and returns the provider's
consent URL. The provider sends the member back to `APP_URL/oauth/callback`, which posts the
answer with their session to `POST /app/oauth/complete`; the API consumes the state once,
checks it belongs to the same person who is still a member, exchanges the code, stores the
account and links the calendar. Tokens are refreshed on use (two minutes before expiry, one
refresh at a time per account) and by the worker every 10 minutes for tokens about to expire,
so revoked grants show up on the Connected accounts page within minutes.

### Setup

1. **Google**: in Google Cloud Console create an OAuth client of type _Web application_, add
   the authorized redirect URI `https://<APP_URL host>/oauth/callback`, enable the Google
   Calendar API and add the scopes above to the consent screen (verification is required before
   external users can connect). Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
2. **Microsoft 365**: in Microsoft Entra ID register an application (multitenant for
   customers' tenants), add the _Web_ redirect URI `https://<APP_URL host>/oauth/callback`, the
   delegated Graph permissions `User.Read` and `Calendars.ReadWrite`, and a client secret. Set
   `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` and optionally
   `MICROSOFT_OAUTH_TENANT` (default `common`).
3. Set them on the API **and** the worker (the worker refreshes tokens). The secrets never
   reach the browser; the redirect URI must match exactly.

## Connection state machine

Implemented in Phase 18 for OAuth accounts (above). Messaging channels, external calendars
and payment connections keep their own status columns (`active`, `configuration_required`,
`error`, `disconnected`); calendars now take their tokens from a connected account when one is
linked.
