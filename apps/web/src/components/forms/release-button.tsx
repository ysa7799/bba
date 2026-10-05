'use client';

import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';

/** "Not spam": processes a quarantined submission into the CRM. */
export function ReleaseButton({ formId, submissionId }: { formId: string; submissionId: string }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <Button
        variant="secondary"
        loading={pending}
        onClick={() =>
          void run(() =>
            apiRequest(
              `/app/orgs/${organizationId}/forms/${formId}/submissions/${submissionId}/release`,
              { method: 'POST' },
            ),
          )
        }
      >
        {m.forms.release}
      </Button>
    </div>
  );
}
