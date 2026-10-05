'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { apiRequest } from '@/lib/api-client';

export function SignOutButton() {
  const m = useMessages();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-60"
      onClick={async () => {
        setPending(true);
        try {
          await apiRequest('/app/auth/logout', { method: 'POST', body: {} });
        } finally {
          router.replace('/login');
          router.refresh();
        }
      }}
    >
      {m.common.signOut}
    </button>
  );
}
