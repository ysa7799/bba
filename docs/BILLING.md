# Billing, Entitlements and Money

Billing/entitlements: implemented in Phase 6 (`packages/billing`). Payments: Phase 7.
Commerce: Phase 14.

## Money

- Representation: integer **minor units** (`bigint`) + ISO 4217 currency code.
- Exponents from a registry: BHD, KWD, OMR, JOD, IQD, LYD, TND = 3; JPY, KRW = 0; most
  others = 2. Unknown currencies are rejected.
- Arithmetic in `bigint`; allocation (splitting) distributes remainders deterministically;
  percentage/tax calculations use explicit rounding (half-even by default, configurable per
  tax rule).
- Formatting/parsing is locale-aware at the edges only. API uses decimal strings.
- No implicit conversion between currencies; mixing currencies throws.

## Plans are data

```
plans → plan_versions → prices (currency, interval, amount_minor)
                     → plan_entitlements (key, value)
subscriptions → subscription_items (price)       billing_customers
usage_metrics → usage_records                     billing_events
```

Code asks entitlement questions, never plan names:

```ts
canUseFeature(org, 'projects.enabled');
getLimit(org, 'crm.contacts.max');
checkUsage(org, 'email.monthly_limit', 1);
consumeUsage(org, 'email.monthly_limit', 1);
```

Entitlement evaluation is independent of any payment provider. Subscription status changes
only from verified provider events or admin action — enforced in the database: tenant scope can
read `subscriptions`, `subscription_items`, `entitlement_overrides` and `billing_events` but has
no write policy on them (RLS), and the catalogue tables are writable only in system scope.

### Resolution

`override (unexpired) > plan version of the live subscription (trialing, active, past_due) >
registry fallback`. Paused, incomplete and canceled subscriptions fall back to the baseline.
Unknown or malformed stored values are ignored (never broaden access).

Stored values use an envelope `{ "value": … }` so that `null` (unlimited) is distinct from SQL
NULL.

### Kinds

| Kind    | Meaning                                           | Enforcement                                                                                                                    |
| ------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| feature | boolean switch                                    | `requireFeature` (402 when off)                                                                                                |
| limit   | concurrent maximum (null = unlimited)             | caller counts rows under a row lock, `assertWithinLimit`                                                                       |
| quota   | per calendar month in the organization's timezone | `consumeUsage`: one conditional `UPDATE … WHERE used + n <= limit`, idempotency keys, rolls back with the caller's transaction |

### Seats

`users.max` counts active members plus pending, unexpired invitations; checked (with an
organization row lock) on invitation, on joining (in case the plan was lowered) and on
reactivation.

### Plans

`plans → plan_versions (draft → published → retired) → plan_entitlements, prices`. Editing a plan
means publishing a new version; existing subscribers stay on their version until moved
(`changeSubscriptionPlan`). New organizations are subscribed to the default plan (if one is
configured). `pnpm db:seed` loads an example BHD catalogue for development.

## Entitlement keys (initial)

users.max · workspaces.max · crm.contacts.max · crm.pipelines.max · automation.workflows.max ·
automation.monthly_executions · email.monthly_limit · sms.monthly_limit ·
whatsapp.monthly_limit · storage.bytes · ai.monthly_credits · projects.enabled ·
helpdesk.enabled · marketing.enabled · api.enabled · white_label.enabled ·
custom_domain.enabled
