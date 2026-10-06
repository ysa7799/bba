import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { ApiKeysPanel } from '@/components/developers/api-keys-panel';
import { WebhooksPanel } from '@/components/developers/webhooks-panel';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type {
  ApiKeySummary,
  DeveloperOverview,
  WebhookEndpointSummary,
} from '@/lib/developer-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function DevelopersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access || !me) notFound();
  if (!access.permissions.includes('api.manage')) {
    return <CrmForbidden title={m.developers.title} message={m.developers.forbidden} />;
  }
  const base = `/app/orgs/${orgId}/developers`;
  const [overview, keys, webhooks] = await Promise.all([
    serverGetJson<DeveloperOverview>(base),
    serverGetJson<{ data: ApiKeySummary[] }>(`${base}/api-keys`),
    serverGetJson<{ data: WebhookEndpointSummary[] }>(`${base}/webhooks`),
  ]);
  if (!overview || !keys || !webhooks) notFound();
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.developers.title} />
      <div className="max-w-4xl space-y-6">
        {overview.enabled ? null : (
          <Alert tone="info">
            {m.developers.notIncluded}{' '}
            <Link href={`/o/${orgId}/billing`} className="font-medium underline">
              {m.developers.upgrade}
            </Link>
          </Alert>
        )}
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {m.developers.baseUrl}
          </p>
          <code
            dir="ltr"
            data-testid="api-base-url"
            className="mt-1 block break-all text-sm text-slate-900"
          >
            {overview.apiBaseUrl}
          </code>
          <p className="mt-2 text-sm text-slate-600">{m.developers.docsHint}</p>
          <p className="mt-1 text-sm text-slate-600">{m.developers.signatureHelp}</p>
        </Card>
        <ApiKeysPanel overview={overview} keys={keys.data} timezone={timezone} />
        <WebhooksPanel overview={overview} endpoints={webhooks.data} />
      </div>
    </OrgAccessBoundary>
  );
}
