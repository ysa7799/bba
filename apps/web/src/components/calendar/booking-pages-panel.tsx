'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { CheckboxField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { AppointmentTypeSummary, BookingPageSummary } from '@/lib/calendar-types';

export function BookingPagesPanel({
  pages,
  types,
}: {
  pages: BookingPageSummary[];
  types: AppointmentTypeSummary[];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('calendar.manage');
  const [editing, setEditing] = useState<BookingPageSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BookingPageSummary | null>(null);
  const { run, pending, error } = useMutation();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{m.calendar.pagesHint}</p>
        {canManage && types.length > 0 ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {m.calendar.newPage}
          </Button>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {pages.length === 0 ? (
        <EmptyState title={m.calendar.noPages} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {pages.map((page) => (
            <li key={page.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {page.title}
                  {page.isActive ? '' : ` · ${m.calendar.inactive}`}
                </p>
                <p className="text-xs text-slate-500">
                  {m.calendar.publicLink}:{' '}
                  <a
                    href={`/book/${page.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-brand-600 hover:underline"
                  >
                    /book/{page.slug}
                  </a>{' '}
                  · {page.appointmentTypes.map((type) => type.name).join(', ')}
                </p>
              </div>
              {canManage ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(page)}>
                    {m.crm.edit}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(page)}>
                    {m.calendar.deletePage}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <PageDialog
          page={editing === 'new' ? null : editing}
          types={types}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={m.calendar.deletePage}
        message={m.calendar.deletePageConfirm}
        confirmLabel={m.calendar.deletePage}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onConfirm={() =>
          void run(() =>
            apiRequest(`/app/orgs/${organizationId}/calendar/booking-pages/${deleting?.id ?? ''}`, {
              method: 'DELETE',
            }),
          ).then((ok) => {
            if (ok) setDeleting(null);
          })
        }
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function PageDialog({
  page,
  types,
  onClose,
}: {
  page: BookingPageSummary | null;
  types: AppointmentTypeSummary[];
  onClose: () => void;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [title, setTitle] = useState(page?.title ?? '');
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [description, setDescription] = useState(page?.description ?? '');
  const [isActive, setIsActive] = useState(page?.isActive ?? true);
  const [typeIds, setTypeIds] = useState<string[]>(
    page?.appointmentTypes.map((type) => type.id) ?? types.slice(0, 1).map((type) => type.id),
  );

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      title,
      description: description.trim() || null,
      isActive,
      appointmentTypeIds: typeIds,
      ...(slug.trim() ? { slug: slug.trim() } : {}),
    };
    const base = `/app/orgs/${organizationId}/calendar/booking-pages`;
    const ok = await run(() =>
      page
        ? apiRequest(`${base}/${page.id}`, { method: 'PATCH', body })
        : apiRequest(base, { body }),
    );
    if (ok) onClose();
  }

  return (
    <Dialog open onClose={onClose} title={page ? m.calendar.editPage : m.calendar.newPage}>
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <TextField
          label={m.calendar.pageTitle}
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextField
          label={m.calendar.pageSlug}
          maxLength={64}
          value={slug}
          hint={m.calendar.pageSlugHint}
          error={error?.fieldError('slug')}
          onChange={(event) => setSlug(event.target.value)}
        />
        <TextAreaField
          label={m.calendar.description}
          rows={2}
          maxLength={2_000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-slate-800">{m.calendar.pageTypes}</legend>
          {types.map((type) => (
            <CheckboxField
              key={type.id}
              label={type.name}
              checked={typeIds.includes(type.id)}
              onChange={(event) =>
                setTypeIds((current) =>
                  event.target.checked
                    ? [...current, type.id]
                    : current.filter((id) => id !== type.id),
                )
              }
            />
          ))}
        </fieldset>
        <CheckboxField
          label={m.calendar.active}
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {m.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
