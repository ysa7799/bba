'use client';

import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { TagSummary } from '@/lib/crm-types';
import { TAG_COLOR_NAMES, TagBadge } from './tag-badge';

export function TagSettings({ tags }: { tags: TagSummary[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('crm.tag.manage');
  const { run, pending, error } = useMutation();
  const [name, setName] = useState('');
  const [color, setColor] = useState('slate');
  const base = `/app/orgs/${organizationId}/crm/tags`;

  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-sm font-semibold text-slate-900">{m.crm.settings.tags}</h2>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {tags.length === 0 ? (
        <p className="text-sm text-slate-500">{m.crm.noTags}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <li key={tag.id} className="flex items-center gap-1">
              <TagBadge tag={tag} />
              {canManage ? (
                <button
                  type="button"
                  aria-label={`${m.crm.delete}: ${tag.name}`}
                  className="text-xs text-slate-400 hover:text-red-700"
                  onClick={() => {
                    if (
                      window.confirm(format(m.crm.settings.deleteTagConfirm, { name: tag.name }))
                    ) {
                      void run(() => apiRequest(`${base}/${tag.id}`, { method: 'DELETE' }));
                    }
                  }}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={m.crm.settings.tagName}
            placeholder={m.crm.settings.tagName}
            maxLength={50}
            className={`${inputClass} w-56`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <select
            aria-label={m.crm.settings.tagColor}
            className={`${inputClass} w-32`}
            value={color}
            onChange={(event) => setColor(event.target.value)}
          >
            {TAG_COLOR_NAMES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            loading={pending}
            disabled={!name.trim()}
            onClick={() =>
              void run(() => apiRequest(base, { body: { name, color } })).then((ok) => {
                if (ok) setName('');
              })
            }
          >
            {m.crm.settings.newTag}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
