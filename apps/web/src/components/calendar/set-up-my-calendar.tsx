'use client';

import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';

/** Creates the member's personal calendar (with default working hours) on demand. */
export function SetUpMyCalendar() {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  return (
    <Alert tone="info">
      <p className="mb-2">{m.calendar.myCalendarHint}</p>
      {error ? <p className="mb-2 text-red-700">{error.message}</p> : null}
      <Button
        size="sm"
        loading={pending}
        onClick={() =>
          void run(() =>
            apiRequest(`/app/orgs/${organizationId}/calendar/calendars/me`, { body: {} }),
          )
        }
      >
        {m.calendar.setUpMyCalendar}
      </Button>
    </Alert>
  );
}
