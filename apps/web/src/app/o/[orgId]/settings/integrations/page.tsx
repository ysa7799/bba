import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { StatusBadge } from '@/components/developers/status-badge';
import { AccountsList } from '@/components/integrations/accounts-list';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { IntegrationAccountSummary, OAuthProviderInfo } from '@/lib/integration-types';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function IntegrationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const base = `/app/orgs/${orgId}/integrations`;
  const [accounts, providers, me] = await Promise.all([
    serverGetJson<{ data: IntegrationAccountSummary[] }>(`${base}/accounts`),
    serverGetJson<{ data: OAuthProviderInfo[] }>(`${base}/providers`),
    getMe(),
  ]);
  if (!accounts || !providers || !me) notFound();
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.integrations.title} />
      <div className="max-w-4xl space-y-6">
        <p className="text-sm text-slate-600">{m.integrations.intro}</p>
        <Card className="p-5">
          <AccountsList accounts={accounts.data} timezone={timezone} currentUserId={me.user.id} />
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.integrations.providers}</h2>
          <ul className="divide-y divide-slate-100" aria-label={m.integrations.providers}>
            {providers.data.map((provider) => (
              <li key={provider.key} className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm text-slate-800">{provider.label}</span>
                <StatusBadge
                  tone={provider.configured ? 'good' : 'muted'}
                  label={
                    provider.configured ? m.integrations.available : m.integrations.notConfigured
                  }
                />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </OrgAccessBoundary>
  );
}
