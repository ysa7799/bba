# Product Vision — BusinessOS

> Working name. Brand identity is configuration (see white-label), not code.

## Mission

Give a growing business one account in which to run customers, sales, communications,
marketing, automation, appointments, projects, support, invoicing, payments, people,
operations, analytics and AI — instead of stitching together ten tools.

Category inspiration (no code, design or branding is copied): agency CRM/marketing suites,
SMB office suites, open-source ERPs, inbound CRMs, enterprise CRMs, work management tools,
helpdesks, schedulers, iPaaS/automation tools and SMB accounting tools.

## Initial market

- **Bahrain first**, then the GCC; MENA and international later.
- Primary currency **BHD** (3 decimal places). Currency is always explicit; USD is never
  assumed.
- Regional payment providers first (Tap Payments; BENEFIT-related flows via providers that
  support them), regional/global messaging providers, Arabic + English UI with RTL support.
- Multiple currencies, timezones and tax configurations per organization from day one in the
  data model.

## Who it is for

| Persona                            | Needs                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Owner / GM of an SMB (5–200 staff) | One system, clear numbers, low admin                   |
| Sales manager / reps               | Pipeline, follow-ups, WhatsApp-first communication     |
| Operations / support staff         | Tickets, appointments, tasks, projects                 |
| Finance / admin                    | Quotes, invoices, payments, BHD/VAT correctness        |
| Agencies (later)                   | Manage many client organizations under their own brand |

## Product pillars

1. **Customer core** — CRM (contacts, companies, deals, pipelines, tasks, notes, tags,
   custom fields) with a unified activity timeline.
2. **Conversations** — unified inbox across email, WhatsApp and SMS (more channels later).
3. **Capture & schedule** — forms and booking pages feeding the CRM.
4. **Automation** — durable workflow engine (trigger → conditions → actions → waits →
   branches) that every module plugs into.
5. **Revenue** — products, quotes, invoices, payments, refunds; BHD-correct money.
6. **Delivery** — projects and helpdesk tied back to customers.
7. **Growth** — campaigns, segments, consent and attribution.
8. **Insight** — dashboards and permission-aware reporting.
9. **Platform** — RBAC, entitlements, audit, public API, webhooks, integrations,
   white-label, AI assistance that cannot exceed the user's own permissions.

## Principles

- **Trust first.** Tenant isolation, authorization, payment integrity and auditability are
  product features, not afterthoughts.
- **Honest software.** No feature appears in the UI before it works end to end. Integrations
  without credentials are shown as "configuration required", never faked.
- **Regional by design.** BHD, Arabic/RTL, GCC payment and messaging realities are first-class.
- **Composable modules on one data model.** Every module emits domain events and appears in
  the customer timeline; automation and reporting work across all of them.
- **Plans are data.** Subscriptions grant entitlements; code checks entitlements, never plan
  names.

## Success criteria for v1 (core platform)

A business can: register → create an organization → invite a team → configure roles →
import customers → run its CRM and pipeline → talk to customers in one inbox → capture leads
with forms → book appointments → automate follow-up → quote, invoice and get paid in BHD →
see a dashboard — with every action tenant-isolated, permission-checked and audited where
sensitive.

## Explicitly later

HR, inventory/ERP, full double-entry accounting, custom app platform, landing pages/funnels,
social publishing, payroll. These are sequenced in `docs/ROADMAP.md` after the core platform is
stable and are never shipped as UI placeholders.
