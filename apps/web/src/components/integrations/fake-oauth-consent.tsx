'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';

/** Approve or deny on the fake provider; always returns to this site's callback page. */
export function FakeOAuthConsent({ state }: { state: string }) {
  const m = useMessages();
  const router = useRouter();
  const [email, setEmail] = useState('calendar.owner@example.com');

  function finish(query: Record<string, string>) {
    router.push(`/oauth/callback?${new URLSearchParams({ state, ...query }).toString()}`);
  }

  function approve(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    finish({ code: `fake.${email.trim()}` });
  }

  return (
    <form onSubmit={approve} className="space-y-4">
      <TextField
        label={m.integrations.fakeEmail}
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => finish({ error: 'access_denied' })}>
          {m.integrations.deny}
        </Button>
        <Button type="submit" disabled={!email.trim()}>
          {m.integrations.approve}
        </Button>
      </div>
    </form>
  );
}
