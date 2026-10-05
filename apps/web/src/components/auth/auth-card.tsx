import Link from 'next/link';
import type { ReactNode } from 'react';

/** Centered card layout shared by sign-in, registration and recovery pages. */
export function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-lg font-semibold tracking-tight text-slate-900">
        BusinessOS
      </Link>
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-xl font-semibold text-slate-900">{title}</h1>
        {children}
      </div>
      {footer ? <div className="mt-6 text-sm text-slate-600">{footer}</div> : null}
    </main>
  );
}
