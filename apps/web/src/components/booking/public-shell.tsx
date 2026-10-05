import type { ReactNode } from 'react';
import { getMessages } from '@/i18n';

/** Minimal frame for public pages (booking, forms): the organization's name, not the app. */
export function PublicShell({
  organization,
  poweredBy,
  children,
}: {
  organization: string;
  poweredBy?: string;
  children: ReactNode;
}) {
  const m = getMessages('en');
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10">
      <p className="mb-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {organization}
      </p>
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
      <p className="mt-6 text-center text-xs text-slate-400">{poweredBy ?? m.booking.poweredBy}</p>
    </main>
  );
}
