import Link from 'next/link';
import type { ReactNode } from 'react';
import { getMessages } from '@/i18n';
import { inputClass } from '@/components/ui/field';

/** GET form for list filters: works without JavaScript and keeps filters in the URL. */
export function ListFilters({
  q,
  clearHref,
  children,
}: {
  q: string;
  clearHref: string;
  children?: ReactNode;
}) {
  const m = getMessages('en');
  return (
    <form role="search" className="mb-4 flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1">
        <label htmlFor="crm-q" className="sr-only">
          {m.crm.search}
        </label>
        <input
          id="crm-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder={m.crm.searchPlaceholder}
          className={inputClass}
        />
      </div>
      {children}
      <button
        type="submit"
        className="h-10 rounded-md bg-white px-4 text-sm font-medium text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
      >
        {m.crm.filter}
      </button>
      <Link href={clearHref} className="px-2 text-sm text-slate-600 hover:underline">
        {m.crm.clear}
      </Link>
    </form>
  );
}

export function FilterSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label htmlFor={`filter-${name}`} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      <select
        id={`filter-${name}`}
        name={name}
        defaultValue={value}
        className={`${inputClass} w-auto`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function NextPageLink({ href }: { href: string | null }) {
  const m = getMessages('en');
  if (!href) return null;
  return (
    <div className="mt-4">
      <Link href={href} className="text-sm font-medium text-brand-600 hover:underline">
        {m.common.next} →
      </Link>
    </div>
  );
}
