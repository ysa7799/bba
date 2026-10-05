'use client';

import { useEffect, useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { ExportSummary } from '@/lib/crm-types';
import { formatDateTime } from '@/lib/format';

/** The member's own exports with live status; downloads stream through the same-origin proxy. */
export function ExportsPanel({ initial }: { initial: ExportSummary[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/crm/exports`;
  const [exports, setExports] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = exports.some((item) => item.status === 'queued' || item.status === 'processing');

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void apiRequest<{ data: ExportSummary[] }>(base)
        .then((result) => setExports(result.data))
        .catch(() => undefined);
    }, 2_500);
    return () => clearInterval(timer);
  }, [active, base]);

  async function create(entityType: ExportSummary['entityType']) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(base, { body: { entityType, filters: {} } });
      setExports((await apiRequest<{ data: ExportSummary[] }>(base)).data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setBusy(false);
    }
  }

  const labels = {
    contact: m.crm.contacts.title,
    company: m.crm.companies.title,
    deal: m.crm.deals.title,
  };

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{m.crm.data.exportTitle}</h2>
        <p className="mt-1 text-sm text-slate-600">{m.crm.data.exportHint}</p>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {(['contact', 'company', 'deal'] as const).map((entityType) => (
          <Button
            key={entityType}
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void create(entityType)}
          >
            {m.crm.data.newExport}: {labels[entityType]}
          </Button>
        ))}
      </div>
      {exports.length === 0 ? (
        <p className="text-sm text-slate-500">{m.crm.data.noExports}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm" aria-live="polite">
          {exports.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium text-slate-900">{labels[item.entityType]}</span>
                <span className="text-slate-500"> · {formatDateTime(item.createdAt)}</span>
                {item.rowCount !== null ? (
                  <span className="text-slate-500">
                    {' '}
                    · {format(m.crm.data.rows, { count: String(item.rowCount) })}
                  </span>
                ) : null}
                {item.failureReason ? (
                  <span className="text-red-600"> · {item.failureReason}</span>
                ) : null}
              </span>
              {item.status === 'completed' ? (
                <a
                  href={`/api${base}/${item.id}/download`}
                  className="font-medium text-brand-700 hover:underline"
                  download
                >
                  {m.crm.data.download}
                </a>
              ) : (
                <span className="text-slate-600">{m.crm.data.statuses[item.status]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
