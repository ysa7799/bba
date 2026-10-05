import Link from 'next/link';
import { getMessages } from '@/i18n';
import { cn } from '@/lib/cn';

/** Builder / Submissions switcher of a form's pages. */
export function FormTabs({
  orgId,
  formId,
  current,
  showSubmissions,
}: {
  orgId: string;
  formId: string;
  current: 'builder' | 'submissions';
  showSubmissions: boolean;
}) {
  const m = getMessages('en');
  const base = `/o/${orgId}/forms/${formId}`;
  const tabs = [
    { key: 'builder', href: base, label: m.forms.builder },
    ...(showSubmissions
      ? [{ key: 'submissions', href: `${base}/submissions`, label: m.forms.submissions }]
      : []),
  ];
  return (
    <nav aria-label={m.forms.title} className="mb-6 flex gap-2 border-b border-slate-200 text-sm">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={current === tab.key ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2',
            current === tab.key
              ? 'border-brand-600 font-medium text-slate-900'
              : 'border-transparent text-slate-600 hover:text-slate-900',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
