'use client';

import { useState, useSyncExternalStore, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { FormDetail } from '@/lib/forms-types';

const noop = () => () => undefined;

/** The page's own origin (empty during server rendering). */
function useOrigin(): string {
  return useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => '',
  );
}

export function embedSnippet(origin: string, slug: string, title: string): string {
  const safeTitle = title.replace(/[<>"&]/g, '');
  return `<iframe src="${origin}/f/${slug}/embed" title="${safeTitle}" style="width:100%;height:640px;border:0" loading="lazy"></iframe>`;
}

/** Name, link, sharing and archiving of a form. */
export function FormHeaderActions({ form }: { form: FormDetail }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('forms.manage');
  const { run, pending, error } = useMutation();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const base = `/app/orgs/${organizationId}/forms/${form.id}`;

  if (!canManage) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setEditing(true)}>
        {m.forms.details}
      </Button>
      {form.status === 'active' ? (
        <Button variant="ghost" onClick={() => setArchiving(true)}>
          {m.forms.archive}
        </Button>
      ) : (
        <Button
          variant="secondary"
          loading={pending}
          onClick={() => void run(() => apiRequest(`${base}/restore`, { method: 'POST' }))}
        >
          {m.forms.restore}
        </Button>
      )}
      {error && !archiving ? <Alert tone="error">{error.message}</Alert> : null}
      {editing ? <DetailsDialog form={form} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        open={archiving}
        title={m.forms.archive}
        message={m.forms.archiveConfirm}
        confirmLabel={m.forms.archive}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onConfirm={() =>
          void run(() => apiRequest(`${base}/archive`, { method: 'POST' })).then((ok) => {
            if (ok) setArchiving(false);
          })
        }
        onClose={() => setArchiving(false)}
      />
    </div>
  );
}

function DetailsDialog({ form, onClose }: { form: FormDetail; onClose: () => void }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [name, setName] = useState(form.name);
  const [slug, setSlug] = useState(form.slug);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/forms/${form.id}`, {
        method: 'PATCH',
        body: { name, slug },
      }),
    );
    if (ok) onClose();
  }

  return (
    <Dialog open onClose={onClose} title={m.forms.details}>
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <TextField
          label={m.forms.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
        />
        <TextField
          label={m.forms.link}
          hint={m.forms.linkHint}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          required
          maxLength={64}
          error={error?.fieldError('slug')}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {m.forms.saveDetails}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Public link and embed code of a published form. */
export function SharePanel({ form }: { form: FormDetail }) {
  const m = useMessages();
  const origin = useOrigin();
  const [copied, setCopied] = useState<'link' | 'embed' | null>(null);
  const live = form.published;
  if (!live || form.status !== 'active') return null;
  const link = `${origin}/f/${form.slug}`;
  const snippet = embedSnippet(origin, form.slug, live.settings.title ?? form.name);

  function copy(kind: 'link' | 'embed', text: string) {
    void navigator.clipboard.writeText(text).then(() => setCopied(kind));
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-medium text-slate-800">{m.forms.publicLink}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <a
            href={`/f/${form.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-brand-600 hover:underline"
          >
            /f/{form.slug}
          </a>
          <Button size="sm" variant="ghost" onClick={() => copy('link', link)}>
            {copied === 'link' ? m.forms.copied : m.forms.copy}
          </Button>
        </div>
      </div>
      <div>
        <p className="font-medium text-slate-800">{m.forms.embedCode}</p>
        {live.settings.embedOrigins.length === 0 ? (
          <p className="text-xs text-slate-500">{m.forms.embedNeedsOrigins}</p>
        ) : (
          <div className="mt-1 space-y-1">
            <pre className="overflow-x-auto rounded-md bg-slate-100 p-2 font-mono text-xs text-slate-800">
              {snippet}
            </pre>
            <Button size="sm" variant="ghost" onClick={() => copy('embed', snippet)}>
              {copied === 'embed' ? m.forms.copied : m.forms.copy}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
