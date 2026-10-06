'use client';

import { useCan } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useOrg } from '@/components/app/org-access';
import { StatusBadge } from '@/components/developers/status-badge';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import type { IntegrationAccountSummary } from '@/lib/integration-types';

const TONES = {
  connecting: 'muted',
  active: 'good',
  refresh_required: 'bad',
  error: 'bad',
  disconnected: 'muted',
} as const;

/** Connected accounts with their state; members disconnect their own, managers anyone's. */
export function AccountsList({
  accounts,
  timezone,
  currentUserId,
}: {
  accounts: IntegrationAccountSummary[];
  timezone: string;
  currentUserId: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('integrations.manage');
  const { run, pending, error } = useMutation();

  if (accounts.length === 0) {
    return <p className="text-sm text-slate-500">{m.integrations.empty}</p>;
  }
  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <ul className="divide-y divide-slate-100" aria-label={m.integrations.title}>
        {accounts.map((account) => (
          <li key={account.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                <span className="break-all" dir="ltr">
                  {account.accountLabel}
                </span>
                <StatusBadge
                  tone={TONES[account.status]}
                  label={m.integrations.status[account.status]}
                />
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {account.providerLabel}
                {account.connectedBy
                  ? ` · ${format(m.integrations.connectedBy, { name: account.connectedBy.name })}`
                  : ''}
                {account.lastRefreshedAt
                  ? ` · ${format(m.integrations.lastRefreshed, {
                      time: formatDateTime(account.lastRefreshedAt, timezone),
                    })}`
                  : ''}
              </p>
              {account.lastError && account.status !== 'active' ? (
                <p className="mt-0.5 text-xs text-red-700">{account.lastError}</p>
              ) : null}
            </div>
            {canManage || account.connectedBy?.id === currentUserId ? (
              <Button
                size="sm"
                variant="ghost"
                loading={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      format(m.integrations.disconnectConfirm, { account: account.accountLabel }),
                    )
                  ) {
                    void run(() =>
                      apiRequest(
                        `/app/orgs/${organizationId}/integrations/accounts/${account.id}`,
                        {
                          method: 'DELETE',
                        },
                      ),
                    );
                  }
                }}
              >
                {m.integrations.disconnect}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
