'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { format } from '@/i18n';
import { apiRequest, apiUpload } from '@/lib/api-client';
import type { FileEntityType, FileSummary } from '@/lib/files-types';
import { formatBytes, formatDateTime } from '@/lib/format';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Who may change the files of each kind of record (the API enforces the same rule). */
const UPDATE_PERMISSION: Record<FileEntityType, string> = {
  contact: 'crm.contact.update',
  company: 'crm.company.update',
  deal: 'crm.deal.update',
};

/**
 * Files attached to a contact, company or deal. The server checks the file's real type, size
 * and the organization's storage quota; the size check here only saves a pointless upload.
 */
export function AttachmentsPanel({
  entity,
  files,
  timezone,
}: {
  entity: { type: FileEntityType; id: string };
  files: FileSummary[];
  /** The organization's timezone (times match the rest of the record page). */
  timezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canChange = useCan(UPDATE_PERMISSION[entity.type]);
  const input = useRef<HTMLInputElement>(null);
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const { run, pending, error } = useMutation();
  const base = `/app/orgs/${organizationId}/files`;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setTooLarge(null);
    if (file.size > MAX_FILE_BYTES) {
      setTooLarge(format(m.files.tooLarge, { name: file.name }));
      return;
    }
    const query = new URLSearchParams({
      entityType: entity.type,
      entityId: entity.id,
      name: file.name,
    });
    await run(() => apiUpload(`${base}?${query.toString()}`, file));
  }

  function remove(file: FileSummary) {
    if (!window.confirm(format(m.files.deleteConfirm, { name: file.name }))) return;
    void run(() => apiRequest(`${base}/${file.id}`, { method: 'DELETE' }));
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{m.files.title}</h2>
        {canChange ? (
          <>
            <input
              ref={input}
              id={`attach-${entity.id}`}
              type="file"
              className="sr-only"
              aria-label={m.files.upload}
              onChange={(event) => void upload(event)}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={pending}
              onClick={() => input.current?.click()}
            >
              {pending ? m.files.uploading : m.files.upload}
            </Button>
          </>
        ) : null}
      </div>
      {tooLarge ? <Alert tone="error">{tooLarge}</Alert> : null}
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {files.length === 0 ? (
        <p className="text-sm text-slate-500">{m.files.empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={m.files.title}>
          {files.map((file) => {
            const href = `/api${base}/${file.id}/content`;
            return (
              <li key={file.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <a
                    href={file.inline ? `${href}?inline=1` : href}
                    target={file.inline ? '_blank' : undefined}
                    rel={file.inline ? 'noopener noreferrer' : undefined}
                    dir="auto"
                    className="block truncate text-sm font-medium text-brand-700 hover:underline"
                  >
                    {file.name}
                  </a>
                  <p className="text-xs text-slate-500">
                    {format(m.files.uploadedBy, {
                      size: formatBytes(file.sizeBytes),
                      name: file.uploadedBy?.name ?? '—',
                      date: formatDateTime(file.createdAt, timezone),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  {/* The API answers with `Content-Disposition: attachment` and the exact name. */}
                  <a href={href} className="font-medium text-slate-600 hover:underline">
                    {m.files.download}
                  </a>
                  {canChange ? (
                    <button
                      type="button"
                      className="font-medium text-red-600 hover:text-red-800"
                      onClick={() => remove(file)}
                    >
                      {m.files.delete}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canChange ? <p className="mt-3 text-xs text-slate-400">{m.files.hint}</p> : null}
    </Card>
  );
}
