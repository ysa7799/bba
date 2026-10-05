'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';

/** Deletes a record after confirmation, then navigates to `redirectTo`. */
export function DeleteRecordButton({
  path,
  title,
  message,
  redirectTo,
}: {
  path: string;
  title: string;
  message: string;
  redirectTo?: string;
}) {
  const m = useMessages();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending, error } = useMutation();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {m.crm.delete}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        message={message}
        confirmLabel={m.crm.delete}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          void run(() => apiRequest(path, { method: 'DELETE' })).then((ok) => {
            if (ok) {
              setOpen(false);
              if (redirectTo) router.push(redirectTo);
            }
          });
        }}
      />
    </>
  );
}
