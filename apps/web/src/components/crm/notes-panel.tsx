'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { NoteSummary } from '@/lib/crm-types';
import { formatDateTime } from '@/lib/format';

/** Notes on a contact, company or deal: newest first, plain text (rendered as text, never HTML). */
export function NotesPanel({
  parentPath,
  notes,
  currentUserId,
}: {
  /** e.g. `contacts/<id>` */
  parentPath: string;
  notes: NoteSummary[];
  currentUserId: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canCreate = useCan('crm.note.create');
  const canModerate = useCan('crm.note.manage');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const { run, pending, error } = useMutation();
  const base = `/app/orgs/${organizationId}/crm`;

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim()) return;
    const ok = await run(() => apiRequest(`${base}/${parentPath}/notes`, { body: { body } }));
    if (ok) setBody('');
  }

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.crm.notes.title}</h2>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {canCreate ? (
        <form onSubmit={add} className="mb-4 space-y-2">
          <label htmlFor="new-note" className="sr-only">
            {m.crm.notes.add}
          </label>
          <textarea
            id="new-note"
            rows={3}
            maxLength={20_000}
            className={inputClass}
            placeholder={m.crm.notes.placeholder}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={pending} disabled={!body.trim()}>
              {m.crm.notes.add}
            </Button>
          </div>
        </form>
      ) : null}
      {notes.length === 0 ? (
        <p className="text-sm text-slate-500">{m.crm.notes.empty}</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => {
            const mine = note.authorUserId === currentUserId;
            const canChange = canModerate || (canCreate && mine);
            return (
              <li key={note.id} className="rounded-md bg-slate-50 p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    <span className="font-medium text-slate-700">{note.authorName ?? '—'}</span> ·{' '}
                    {formatDateTime(note.createdAt)}
                    {note.edited ? ` · ${m.crm.notes.edited}` : ''}
                  </span>
                  {canChange && editing?.id !== note.id ? (
                    <span className="flex gap-2">
                      <button
                        type="button"
                        className="font-medium hover:text-slate-900"
                        onClick={() => setEditing({ id: note.id, body: note.body })}
                      >
                        {m.crm.edit}
                      </button>
                      <button
                        type="button"
                        className="font-medium text-red-600 hover:text-red-800"
                        onClick={() => {
                          if (window.confirm(m.crm.notes.deleteConfirm)) {
                            void run(() =>
                              apiRequest(`${base}/notes/${note.id}`, { method: 'DELETE' }),
                            );
                          }
                        }}
                      >
                        {m.crm.delete}
                      </button>
                    </span>
                  ) : null}
                </div>
                {editing?.id === note.id ? (
                  <div className="space-y-2">
                    <textarea
                      aria-label={m.crm.edit}
                      rows={3}
                      className={inputClass}
                      value={editing.body}
                      onChange={(event) => setEditing({ id: note.id, body: event.target.value })}
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {m.common.cancel}
                      </Button>
                      <Button
                        size="sm"
                        loading={pending}
                        onClick={() =>
                          void run(() =>
                            apiRequest(`${base}/notes/${note.id}`, {
                              method: 'PATCH',
                              body: { body: editing.body },
                            }),
                          ).then((ok) => {
                            if (ok) setEditing(null);
                          })
                        }
                      >
                        {m.crm.save}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm text-slate-800">
                    {note.body}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
