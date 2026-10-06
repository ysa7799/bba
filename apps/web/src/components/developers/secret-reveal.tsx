'use client';

import { useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/**
 * Shows a newly issued secret (API key or signing secret) exactly once. It lives only in this
 * component's state: closing the dialog discards it.
 */
export function SecretReveal({
  title,
  warning,
  secret,
  onClose,
}: {
  title: string;
  warning: string;
  secret: string | null;
  onClose: () => void;
}) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={secret !== null}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      title={title}
    >
      <div className="space-y-4">
        <Alert tone="info">{warning}</Alert>
        <div className="flex items-center gap-2">
          <code
            data-testid="revealed-secret"
            dir="ltr"
            className="min-w-0 flex-1 select-all break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-900"
          >
            {secret}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(secret ?? '')
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? m.developers.copied : m.developers.copy}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            {m.developers.done}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
