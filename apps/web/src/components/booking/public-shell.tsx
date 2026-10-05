import type { ReactNode } from 'react';
import { getMessages } from '@/i18n';

/** Minimal frame for public booking pages: the organization's name, not the platform's app. */
export function PublicShell({
  organization,
  children,
}: {
  organization: string;
  children: ReactNode;
}) {
  const m = getMessages('en');
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10">
      <p className="mb-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {organization}
      </p>
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
      <p className="mt-6 text-center text-xs text-slate-400">{m.booking.poweredBy}</p>
    </main>
  );
}
