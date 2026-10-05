'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass, SelectField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { ImportDetail, ImportFull, ImportPreviewRow } from '@/lib/crm-types';
import { formatDateTime } from '@/lib/format';

const MAX_BYTES = 5 * 1024 * 1024;
const ACTIVE = new Set(['queued', 'processing']);

/** Upload → map columns → preview → run, with live progress and per-row errors. */
export function ImportWizard({ recent }: { recent: ImportDetail[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/crm/imports`;
  const [entityType, setEntityType] = useState<'contact' | 'company'>('contact');
  const [current, setCurrent] = useState<ImportFull | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<'skip' | 'update'>('skip');
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (id: string) => {
      const { import: detail } = await apiRequest<{ import: ImportFull }>(`${base}/${id}`);
      setCurrent(detail);
      setMapping(detail.mapping);
      setPolicy(detail.duplicatePolicy);
      return detail;
    },
    [base],
  );

  async function guarded(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? [caught.message, ...caught.details.map((d) => `${d.path}: ${d.message}`)].join(' — ')
          : m.common.genericError,
      );
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(m.crm.data.importHint);
      return;
    }
    await guarded(async () => {
      const content = await file.text();
      const { import: created } = await apiRequest<{ import: ImportDetail }>(base, {
        body: { entityType, fileName: file.name, content },
      });
      setPreview(null);
      await load(created.id);
    });
  }

  const saveMapping = () =>
    apiRequest(`${base}/${current?.id ?? ''}`, {
      method: 'PATCH',
      body: { mapping, duplicatePolicy: policy },
    });

  // Poll while the worker processes the import.
  useEffect(() => {
    if (!current || !ACTIVE.has(current.status)) return;
    const timer = setInterval(() => {
      void load(current.id).catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [current, load]);

  const editable = current?.status === 'uploaded';

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{m.crm.data.importTitle}</h2>
          <p className="mt-1 text-sm text-slate-600">{m.crm.data.importHint}</p>
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!current || !editable ? (
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label={m.crm.data.entity}
              value={entityType}
              onChange={(event) => setEntityType(event.target.value as 'contact' | 'company')}
            >
              <option value="contact">{m.crm.contacts.title}</option>
              <option value="company">{m.crm.companies.title}</option>
            </SelectField>
            <div>
              <label htmlFor="import-file" className="block text-sm font-medium text-slate-800">
                {m.crm.data.file}
              </label>
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(event) => void onFile(event)}
                disabled={busy}
                className="mt-1.5 block text-sm text-slate-700 file:me-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
              />
            </div>
          </div>
        ) : null}

        {current && editable ? (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">
              {m.crm.data.mapping}: {current.fileName}
            </h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-2 py-1 text-start">{m.crm.data.column}</th>
                    <th className="px-2 py-1 text-start">{m.crm.data.sample}</th>
                    <th className="px-2 py-1 text-start">{m.crm.data.field}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {current.headers.map((header, index) => (
                    <tr key={`${header}-${String(index)}`}>
                      <td className="px-2 py-1.5 font-medium text-slate-800">{header}</td>
                      <td className="max-w-48 truncate px-2 py-1.5 text-slate-500">
                        {current.sampleRows[0]?.[index] ?? ''}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={`${m.crm.data.field}: ${header}`}
                          className={`${inputClass} w-56`}
                          value={mapping[String(index)] ?? ''}
                          onChange={(event) =>
                            setMapping((currentMapping) => ({
                              ...currentMapping,
                              [String(index)]: event.target.value,
                            }))
                          }
                        >
                          <option value="">{m.crm.data.skip}</option>
                          {current.fields.map((field) => (
                            <option key={field.key} value={field.key}>
                              {field.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium text-slate-800">
                {m.crm.data.duplicates}
              </legend>
              {(['skip', 'update'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="duplicatePolicy"
                    checked={policy === value}
                    onChange={() => setPolicy(value)}
                  />
                  {value === 'skip' ? m.crm.data.duplicateSkip : m.crm.data.duplicateUpdate}
                </label>
              ))}
              <p className="text-xs text-slate-500">{m.crm.data.duplicatesHint}</p>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={busy}
                onClick={() =>
                  void guarded(async () => {
                    await saveMapping();
                    const result = await apiRequest<{ data: ImportPreviewRow[] }>(
                      `${base}/${current.id}/preview`,
                    );
                    setPreview(result.data);
                  })
                }
              >
                {m.crm.data.preview}
              </Button>
              <Button
                loading={busy}
                onClick={() =>
                  void guarded(async () => {
                    await saveMapping();
                    await apiRequest(`${base}/${current.id}/start`, { body: {} });
                    setPreview(null);
                    await load(current.id);
                  })
                }
              >
                {m.crm.data.start}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  void guarded(async () => {
                    await apiRequest(`${base}/${current.id}/cancel`, { body: {} });
                    setCurrent(null);
                  })
                }
              >
                {m.crm.data.cancel}
              </Button>
            </div>
            {preview ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-2 py-1 text-start">{m.crm.data.row}</th>
                      <th className="px-2 py-1 text-start">{m.crm.data.field}</th>
                      <th className="px-2 py-1 text-start">{m.crm.contacts.status}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="px-2 py-1.5 text-slate-500">{row.rowNumber}</td>
                        <td className="px-2 py-1.5 text-slate-700">
                          {Object.entries(row.values)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(' · ')}
                        </td>
                        <td
                          className={
                            row.error ? 'px-2 py-1.5 text-red-600' : 'px-2 py-1.5 text-emerald-700'
                          }
                        >
                          {row.error ?? m.crm.data.ok}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}

        {current && !editable ? (
          <div className="space-y-2" role="status">
            <p className="text-sm font-medium text-slate-900">
              {current.fileName} — {m.crm.data.statuses[current.status]}
            </p>
            <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
              <div
                className="h-full bg-brand-600 transition-all"
                style={{
                  width: `${current.totalRows === 0 ? 0 : Math.round((current.processedRows / current.totalRows) * 100)}%`,
                }}
              />
            </div>
            <p className="text-sm text-slate-600">
              {format(m.crm.data.progress, {
                processed: String(current.processedRows),
                total: String(current.totalRows),
              })}
            </p>
            <p className="text-sm text-slate-600">
              {format(m.crm.data.results, {
                created: String(current.createdCount),
                updated: String(current.updatedCount),
                skipped: String(current.skippedCount),
                failed: String(current.failedCount),
              })}
            </p>
            {current.errors.length > 0 ? (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium text-slate-800">
                  {m.crm.data.errors}
                </summary>
                <ul className="mt-2 space-y-1">
                  {current.errors.map((row) => (
                    <li key={row.rowNumber} className="text-red-700">
                      {m.crm.data.row} {row.rowNumber}: {row.error}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.crm.data.recentImports}</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-500">{m.crm.data.noImports}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {recent.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button
                  type="button"
                  className="font-medium text-slate-900 hover:underline"
                  onClick={() =>
                    void guarded(async () => {
                      await load(item.id);
                    })
                  }
                >
                  {item.fileName}
                </button>
                <span className="text-slate-600">
                  {m.crm.data.statuses[item.status]} · {formatDateTime(item.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
