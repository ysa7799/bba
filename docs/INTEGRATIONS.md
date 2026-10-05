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

| Port               | Phase | First adapters                        | Live status            |
| ------------------ | ----- | ------------------------------------- | ---------------------- |
| `PaymentProvider`  | 7     | Tap Payments, Fake (implemented)      | CONFIGURATION_REQUIRED |
| `EmailProvider`    | 10/16 | SMTP, Postmark/Resend/SES-ready, Fake | CONFIGURATION_REQUIRED |
| `WhatsAppProvider` | 10    | WhatsApp Cloud API-compatible, Fake   | CONFIGURATION_REQUIRED |
| `SmsProvider`      | 10    | Generic HTTP, Fake                    | CONFIGURATION_REQUIRED |
| `StorageProvider`  | 16    | S3-compatible, local FS (dev)         | CONFIGURATION_REQUIRED |
| `CalendarProvider` | 11/18 | Google, Microsoft                     | CONFIGURATION_REQUIRED |
| `AIProvider`       | 20    | Anthropic-compatible, Fake            | CONFIGURATION_REQUIRED |

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

## Connection state machine (Phase 18)

`connecting → active → (refresh_required | error) → active | disconnected`

Tracked fields: definition, provider, connection owner org, encrypted credentials, scopes,
external account id, token expiry, sync state, webhook status, last error.
