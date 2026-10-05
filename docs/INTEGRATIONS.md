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

| Port | Phase | First adapters | Live status |
| --- | --- | --- | --- |
| `PaymentProvider` | 7 | Tap Payments, Fake | CONFIGURATION_REQUIRED |
| `EmailProvider` | 10/16 | SMTP, Postmark/Resend/SES-ready, Fake | CONFIGURATION_REQUIRED |
| `WhatsAppProvider` | 10 | WhatsApp Cloud API-compatible, Fake | CONFIGURATION_REQUIRED |
| `SmsProvider` | 10 | Generic HTTP, Fake | CONFIGURATION_REQUIRED |
| `StorageProvider` | 16 | S3-compatible, local FS (dev) | CONFIGURATION_REQUIRED |
| `CalendarProvider` | 11/18 | Google, Microsoft | CONFIGURATION_REQUIRED |
| `AIProvider` | 20 | Anthropic-compatible, Fake | CONFIGURATION_REQUIRED |

## Connection state machine (Phase 18)

`connecting → active → (refresh_required | error) → active | disconnected`

Tracked fields: definition, provider, connection owner org, encrypted credentials, scopes,
external account id, token expiry, sync state, webhook status, last error.
