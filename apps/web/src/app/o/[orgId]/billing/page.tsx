import { notFound } from 'next/navigation';
import { BillingProfileForm } from '@/components/app/billing-profile-form';
import { SubscribeButton } from '@/components/app/subscribe-button';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type {
  BillingCustomer,
  CatalogPlan,
  EntitlementsResponse,
  PaymentsConfig,
  SubscriptionResponse,
} from '@/lib/api-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const LIMIT_LABELS: Record<string, string> = {
  'users.max': 'Members',
  'crm.contacts.max': 'Contacts',
  'crm.pipelines.max': 'Pipelines',
  'automation.workflows.max': 'Workflows',
  'automation.monthly_executions': 'Workflow runs / month',
  'email.monthly_limit': 'Emails / month',
  'sms.monthly_limit': 'SMS / month',
  'whatsapp.monthly_limit': 'WhatsApp messages / month',
  'ai.monthly_credits': 'AI credits / month',
};

const FEATURE_LABELS: Record<string, string> = {
  'projects.enabled': 'Projects',
  'helpdesk.enabled': 'Helpdesk',
  'marketing.enabled': 'Marketing',
  'api.enabled': 'Public API',
  'white_label.enabled': 'White label',
  'custom_domain.enabled': 'Custom domain',
};

function formatLimit(value: boolean | number | null | undefined, unlimited: string): string {
  if (value === null) return unlimited;
  return typeof value === 'number' ? new Intl.NumberFormat('en').format(value) : '—';
}

export default async function BillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  const canManage = access.permissions.includes('settings.billing.manage');
  const [entitlements, catalog, subscription, customer, payments] = await Promise.all([
    serverGetJson<EntitlementsResponse>(`/app/orgs/${orgId}/billing/entitlements`),
    serverGetJson<{ data: CatalogPlan[] }>('/app/billing/plans'),
    canManage
      ? serverGetJson<SubscriptionResponse>(`/app/orgs/${orgId}/billing/subscription`)
      : null,
    canManage
      ? serverGetJson<{ customer: BillingCustomer | null }>(`/app/orgs/${orgId}/billing/customer`)
      : null,
    serverGetJson<PaymentsConfig>('/app/billing/payments-config'),
  ]);
  const checkoutReady = canManage && payments?.status === 'ready';
  const currentPlanId = subscription?.plan?.id ?? null;
  if (!entitlements || !catalog) notFound();

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.app.billing.title} />
      <div className="max-w-4xl space-y-6">
        {canManage ? (
          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold">{m.app.billing.currentPlan}</h2>
            {subscription?.plan ? (
              <p className="text-sm text-slate-700">
                <span className="font-medium text-slate-900">{subscription.plan.name}</span> ·{' '}
                {m.app.billing.status}:{' '}
                <span className="capitalize">{subscription.subscription?.status}</span>
              </p>
            ) : (
              <p className="text-sm text-slate-600">{m.app.billing.noPlan}</p>
            )}
          </Card>
        ) : null}

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">{m.app.billing.usage}</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {Object.entries(LIMIT_LABELS).map(([key, label]) => {
              const limit = entitlements.entitlements[key];
              const used = entitlements.usage[key]?.used;
              const pct =
                typeof limit === 'number' && limit > 0 && used !== undefined
                  ? Math.min(100, Math.round((used / limit) * 100))
                  : null;
              return (
                <div key={key} className="rounded-md border border-slate-200 p-3">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="mt-1 text-sm font-medium text-slate-900">
                    {used !== undefined ? `${new Intl.NumberFormat('en').format(used)} / ` : ''}
                    {formatLimit(limit, m.app.billing.unlimited)}
                  </dd>
                  {pct !== null ? (
                    <div
                      className="mt-2 h-1.5 rounded bg-slate-100"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={label}
                    >
                      <div
                        className={`h-1.5 rounded ${pct >= 90 ? 'bg-red-500' : 'bg-brand-600'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {Object.entries(FEATURE_LABELS).map(([key, label]) => (
              <div key={key} className="rounded-md border border-slate-200 p-3">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {entitlements.entitlements[key] === true
                    ? m.app.billing.included
                    : m.app.billing.notIncluded}
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        {catalog.data.length > 0 ? (
          <section>
            <h2 className="mb-1 text-sm font-semibold">{m.app.billing.plans}</h2>
            {checkoutReady ? null : (
              <p className="mb-3 text-xs text-slate-500">{m.app.billing.changesNote}</p>
            )}
            <div className="grid gap-4 md:grid-cols-3">
              {catalog.data.map((plan) => {
                const monthly = plan.prices.find((price) => price.interval === 'month');
                return (
                  <Card key={plan.id} className="p-5">
                    <h3 className="font-semibold text-slate-900">{plan.name}</h3>
                    <p className="mt-1 text-sm text-slate-600">{plan.description}</p>
                    <p className="mt-3 text-lg font-semibold text-slate-900">
                      {monthly ? `${monthly.currency} ${monthly.amount}` : m.app.billing.free}
                      {monthly ? (
                        <span className="text-sm font-normal text-slate-500">
                          {' '}
                          {m.app.billing.perMonth}
                        </span>
                      ) : null}
                    </p>
                    {plan.id === currentPlanId ? (
                      <p className="mt-4 text-sm font-medium text-emerald-700">
                        {m.app.billing.currentBadge}
                      </p>
                    ) : checkoutReady && monthly ? (
                      <SubscribeButton priceId={monthly.id} />
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </section>
        ) : null}

        {canManage ? <BillingProfileForm customer={customer?.customer ?? null} /> : null}
      </div>
    </OrgAccessBoundary>
  );
}
