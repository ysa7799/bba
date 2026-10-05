'use client';

import { useMessages } from '@/components/i18n-provider';
import { cn } from '@/lib/cn';
import type { TagSummary } from '@/lib/crm-types';

/** Toggle buttons for choosing tags from the organization's tag list. */
export function TagPicker({
  tags,
  value,
  onChange,
}: {
  tags: TagSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const m = useMessages();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-slate-800">{m.crm.tags}</legend>
      {tags.length === 0 ? (
        <p className="text-sm text-slate-500">{m.crm.noTags}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => {
            const selected = value.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onChange(selected ? value.filter((id) => id !== tag.id) : [...value, tag.id])
                }
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                  selected
                    ? 'bg-brand-600 text-white ring-brand-600'
                    : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50',
                )}
              >
                {tag.name}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
