'use client';

import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';

/** Starts a background CSV export of the current list filters. */
export function ExportButton({
  entityType,
  filters,
}: {
  entityType: 'contact' | 'company' | 'deal';
  filters: Record<string, string>;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const allowed = useCan('crm.data.export');
  const [done, setDone] = useState(false);
  const { run, pending, error } = useMutation();
  if (!allowed) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        loading={pending}
        onClick={() =>
          void run(() =>
            apiRequest(`/app/orgs/${organizationId}/crm/exports`, {
              body: { entityType, filters },
            }),
          ).then(setDone)
        }
      >
        {m.crm.exportCsv}
      </Button>
      {done ? (
        <span role="status" className="text-xs text-slate-600">
          {m.crm.exportQueued}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}
