import Link from 'next/link';
import { getMessages } from '@/i18n';
import { cn } from '@/lib/cn';

export function WorkflowTabs({
  orgId,
  workflowId,
  current,
}: {
  orgId: string;
  workflowId: string;
  current: 'builder' | 'runs';
}) {
  const m = getMessages('en');
  const base = `/o/${orgId}/automation/${workflowId}`;
  const tabs = [
    { key: 'builder', href: base, label: m.automation.builder },
    { key: 'runs', href: `${base}/runs`, label: m.automation.runs },
  ] as const;
  return (
    <nav
      aria-label={m.automation.title}
      className="mb-6 flex gap-2 border-b border-slate-200 text-sm"
    >
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

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  archived: 'bg-slate-100 text-slate-500',
  running: 'bg-sky-100 text-sky-800',
  waiting: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-slate-100 text-slate-600',
  skipped: 'bg-slate-100 text-slate-600',
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700',
      )}
    >
      {label}
    </span>
  );
}
