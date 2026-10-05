'use client';

import { useEffect, useId, useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMessages } from '@/components/i18n-provider';
import { inputClass } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { CompanySummary, ContactSummary, DealSummary } from '@/lib/crm-types';

type PickerType = 'contact' | 'company' | 'deal';
export interface PickedRecord {
  id: string;
  name: string;
}

const PATHS: Record<PickerType, string> = {
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
};

function toPicked(
  type: PickerType,
  row: ContactSummary | CompanySummary | DealSummary,
): PickedRecord {
  if (type === 'contact') return { id: row.id, name: (row as ContactSummary).displayName };
  return { id: row.id, name: (row as CompanySummary | DealSummary).name };
}

/** Search-as-you-type selector for a related CRM record. */
export function RecordPicker({
  label,
  type,
  value,
  onChange,
  error,
}: {
  label: string;
  type: PickerType;
  value: PickedRecord | null;
  onChange: (value: PickedRecord | null) => void;
  error?: string | undefined;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const q = query.trim();
  const searching = q.length >= 2;

  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      apiRequest<{ data: (ContactSummary | CompanySummary | DealSummary)[] }>(
        `/app/orgs/${organizationId}/crm/${PATHS[type]}?${new URLSearchParams({ q, limit: '8' }).toString()}`,
      )
        .then((page) => {
          if (!cancelled) setResults(page.data.map((row) => toPicked(type, row)));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, searching, organizationId, type]);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {value ? (
        <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-inset ring-slate-200">
          <span className="truncate text-slate-900">{value.name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="ms-2 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {m.crm.clear}
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            id={id}
            type="search"
            autoComplete="off"
            className={inputClass}
            placeholder={m.crm.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
          {searching ? (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
              {loading && results.length === 0 ? (
                <li className="px-3 py-2 text-slate-500">{m.common.loading}</li>
              ) : results.length === 0 ? (
                <li className="px-3 py-2 text-slate-500">{m.crm.globalSearch.empty}</li>
              ) : (
                results.map((result) => (
                  <li key={result.id}>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-start hover:bg-slate-50"
                      onClick={() => {
                        onChange(result);
                        setQuery('');
                      }}
                    >
                      {result.name}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
