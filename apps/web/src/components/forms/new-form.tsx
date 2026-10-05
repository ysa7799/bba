'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { FormDetail } from '@/lib/forms-types';

export function NewFormButton() {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let created: FormDetail | null = null;
    const ok = await run(
      async () => {
        created = (
          await apiRequest<{ form: FormDetail }>(`/app/orgs/${organizationId}/forms`, {
            body: { name, ...(slug.trim() ? { slug: slug.trim() } : {}) },
          })
        ).form;
      },
      { refresh: false },
    );
    const form = created as FormDetail | null;
    if (ok && form) router.push(`/o/${organizationId}/forms/${form.id}`);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{m.forms.newForm}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={m.forms.newForm}>
        <form onSubmit={submit} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={m.forms.name}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            autoFocus
          />
          <TextField
            label={m.forms.link}
            hint={m.forms.linkHint}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={64}
            error={error?.fieldError('slug')}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.forms.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
