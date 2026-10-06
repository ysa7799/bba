import { cn } from '@/lib/cn';
import type { WebhookEndpointSummary } from '@/lib/developer-types';

/** Small status pill; the text carries the meaning, the color only reinforces it. */
export function StatusBadge({ tone, label }: { tone: 'good' | 'muted' | 'bad'; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'good' && 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200',
        tone === 'muted' && 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200',
        tone === 'bad' && 'bg-red-50 text-red-800 ring-1 ring-inset ring-red-200',
      )}
    >
      {label}
    </span>
  );
}

export function EndpointBadge({
  endpoint,
  labels,
}: {
  endpoint: Pick<WebhookEndpointSummary, 'status' | 'disabledReason'>;
  labels: { active: string; disabled: string; failing: string };
}) {
  if (endpoint.status === 'active') return <StatusBadge tone="good" label={labels.active} />;
  return endpoint.disabledReason === 'failing' ? (
    <StatusBadge tone="bad" label={labels.failing} />
  ) : (
    <StatusBadge tone="muted" label={labels.disabled} />
  );
}
