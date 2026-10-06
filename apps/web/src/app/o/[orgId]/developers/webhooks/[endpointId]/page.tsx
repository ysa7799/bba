import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { DeliveryLog } from '@/components/developers/delivery-log';
import { EndpointActions } from '@/components/developers/endpoint-actions';
import { EndpointBadge } from '@/components/developers/status-badge';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type {
  DeveloperOverview,
  WebhookDeliverySummary,
  WebhookEndpointSummary,
} from '@/lib/developer-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function WebhookEndpointPage({
  params,
}: {
  params: Promise<{ orgId: string; endpointId: string }>;
}) {
  const { orgId, endpointId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access || !me) notFound();
  if (!access.permissions.includes('api.manage')) {
    return <CrmForbidden title={m.developers.title} message={m.developers.forbidden} />;
  }
  const base = `/app/orgs/${orgId}/developers`;
  const [overview, endpoint, deliveries] = await Promise.all([
    serverGetJson<DeveloperOverview>(base),
    serverGetJson<{ endpoint: WebhookEndpointSummary }>(`${base}/webhooks/${endpointId}`),
    serverGetJson<{ data: WebhookDeliverySummary[]; nextCursor: string | null }>(
      `${base}/webhooks/${endpointId}/deliveries?limit=20`,
    ),
  ]);
  if (!overview || !endpoint || !deliveries) notFound();
  const e = endpoint.endpoint;
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <nav className="mb-2 text-sm">
        <Link href={`/o/${orgId}/developers`} className="text-slate-500 hover:underline">
          ← {m.developers.back}
        </Link>
      </nav>
      <PageHeader title={e.description ?? m.developers.webhooksTitle} />
      <div className="max-w-4xl space-y-6">
        <Card className="space-y-3 p-5">
          <p className="flex flex-wrap items-center gap-2">
            <code dir="ltr" className="break-all text-sm font-medium text-slate-900">
              {e.url}
            </code>
            <EndpointBadge endpoint={e} labels={m.developers.status} />
          </p>
          <p className="text-xs text-slate-500" dir="ltr">
            {e.events.join(' · ')}
          </p>
          <EndpointActions
            endpoint={e}
            eventTypes={overview.eventTypes}
            enabled={overview.enabled}
          />
        </Card>
        <Card className="p-5">
          <DeliveryLog
            endpointId={e.id}
            initial={deliveries}
            timezone={timezone}
            canResend={overview.enabled && e.status === 'active'}
          />
        </Card>
      </div>
    </OrgAccessBoundary>
  );
}
