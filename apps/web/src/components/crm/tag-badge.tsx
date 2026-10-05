import { cn } from '@/lib/cn';
import type { TagSummary } from '@/lib/crm-types';

// Static class names so Tailwind keeps them in the build.
const COLORS: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200',
  pink: 'bg-pink-50 text-pink-700 ring-pink-200',
};

export const TAG_COLOR_NAMES = Object.keys(COLORS);

export function TagBadge({
  tag,
  className,
}: {
  tag: Pick<TagSummary, 'name' | 'color'>;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        COLORS[tag.color] ?? COLORS.slate,
        className,
      )}
    >
      {tag.name}
    </span>
  );
}

export function TagList({ tags }: { tags: TagSummary[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <TagBadge key={tag.id} tag={tag} />
      ))}
    </span>
  );
}
