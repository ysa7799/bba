import type { ReactNode } from 'react';

/** Label/value list used on record detail pages. */
export function DetailList({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-slate-500">{label}</dt>
          <dd className="mt-0.5 break-words text-slate-900">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** wa.me link for an E.164 number (opens WhatsApp; no data is sent by BusinessOS). */
export function whatsappHref(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}`;
}
