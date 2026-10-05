'use client';

import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import type { RunStatus } from '@/lib/automation-types';

/** Retry a failed run or cancel one in progress. */
export function RunActions({ runId, status }: { runId: string; status: RunStatus }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('automation.workflow.manage');
  const { run, pending, error } = useMutation();
  if (!canManage) return null;
  const action =
    status === 'failed' ? 'retry' : status === 'running' || status === 'waiting' ? 'cancel' : null;
  if (!action) return null;
  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <Button
        variant={action === 'retry' ? 'primary' : 'secondary'}
        loading={pending}
        onClick={() =>
          void run(() =>
            apiRequest(`/app/orgs/${organizationId}/automation/runs/${runId}/${action}`, {
              method: 'POST',
            }),
          )
        }
      >
        {action === 'retry' ? m.automation.retry : m.automation.cancelRun}
      </Button>
    </div>
  );
}
