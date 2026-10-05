# Billing, Entitlements and Money

_Billing/entitlements land in Phase 6, payments in Phase 7, commerce in Phase 14._

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
only from verified provider events or admin action.

## Entitlement keys (initial)

users.max · workspaces.max · crm.contacts.max · crm.pipelines.max · automation.workflows.max ·
automation.monthly_executions · email.monthly_limit · sms.monthly_limit ·
whatsapp.monthly_limit · storage.bytes · ai.monthly_credits · projects.enabled ·
helpdesk.enabled · marketing.enabled · api.enabled · white_label.enabled ·
custom_domain.enabled
