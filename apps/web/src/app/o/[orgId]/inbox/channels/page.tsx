import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { ChannelSettings } from '@/components/inbox/channel-settings';
import { getMessages } from '@/i18n';
import type { ChannelDetail, ProviderInfo, TemplateSummary } from '@/lib/inbox-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function ChannelsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  if (!access.permissions.includes('communications.manage')) {
    return <CrmForbidden title={m.inbox.channelsTitle} message={m.inbox.channelsForbidden} />;
  }
  const base = `/app/orgs/${orgId}/communications`;
  const [channels, providers, templates] = await Promise.all([
    serverGetJson<{ data: ChannelDetail[] }>(`${base}/channels`),
    serverGetJson<{ encryptionConfigured: boolean; data: ProviderInfo[] }>(
      `${base}/channels/providers`,
    ),
    serverGetJson<{ data: TemplateSummary[] }>(`${base}/templates`),
  ]);
  if (!channels || !providers) notFound();
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <nav className="mb-2 text-sm">
        <Link href={`/o/${orgId}/inbox`} className="text-slate-500 hover:underline">
          ← {m.inbox.title}
        </Link>
      </nav>
      <ChannelSettings
        channels={channels.data}
        providers={providers.data}
        encryptionConfigured={providers.encryptionConfigured}
        templates={templates?.data ?? []}
        timezone={timezone}
      />
    </OrgAccessBoundary>
  );
}
