'use client';

import { useState } from 'react';
import { useOrg, useCan } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { inputClass } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { LIFECYCLE_STAGES, type Assignee, type TagSummary } from '@/lib/crm-types';

type Entity = 'contacts' | 'companies' | 'deals';
const PERMISSION: Record<Entity, string> = {
  contacts: 'contact',
  companies: 'company',
  deals: 'deal',
};

/** Bulk actions for the selected rows of a CRM list. */
export function BulkBar({
  entity,
  ids,
  tags,
  assignees,
  onDone,
}: {
  entity: Entity;
  ids: string[];
  tags: TagSummary[];
  assignees: Assignee[];
  onDone: () => void;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canUpdate = useCan(`crm.${PERMISSION[entity]}.update`);
  const canDelete = useCan(`crm.${PERMISSION[entity]}.delete`);
  const [action, setAction] = useState('');
  const [argument, setArgument] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { run, pending, error } = useMutation();

  if (ids.length === 0 || (!canUpdate && !canDelete)) return null;

  async function submit(body: Record<string, unknown>) {
    setMessage(null);
    let affected = 0;
    const ok = await run(async () => {
      const result = await apiRequest<{ affected: number }>(
        `/app/orgs/${organizationId}/crm/${entity}/bulk`,
        {
          body: { ...body, ids },
        },
      );
      affected = result.affected;
    });
    if (ok) {
      setMessage(format(m.crm.bulkDone, { count: String(affected) }));
      setAction('');
      setArgument('');
      setConfirmDelete(false);
      onDone();
    }
  }

  function apply() {
    switch (action) {
      case 'assign_owner':
        void submit({ action, ownerUserId: argument || null });
        break;
      case 'add_tags':
      case 'remove_tags':
        if (argument) void submit({ action, tagIds: [argument] });
        break;
      case 'set_lifecycle':
        if (argument) void submit({ action, lifecycleStage: argument });
        break;
      default:
        break;
    }
  }

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-sm">
        <span className="font-medium text-slate-800">
          {format(m.crm.selected, { count: String(ids.length) })}
        </span>
        {canUpdate ? (
          <>
            <select
              aria-label={m.crm.apply}
              className={`${inputClass} w-auto`}
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setArgument('');
              }}
            >
              <option value="">—</option>
              <option value="assign_owner">{m.crm.bulkAssign}</option>
              <option value="add_tags">{m.crm.bulkTag}</option>
              <option value="remove_tags">{m.crm.bulkUntag}</option>
              {entity === 'contacts' ? (
                <option value="set_lifecycle">{m.crm.bulkLifecycle}</option>
              ) : null}
            </select>
            {action === 'assign_owner' ? (
              <select
                aria-label={m.crm.owner}
                className={`${inputClass} w-auto`}
                value={argument}
                onChange={(event) => setArgument(event.target.value)}
              >
                <option value="">{m.crm.noOwner}</option>
                {assignees.map((assignee) => (
                  <option key={assignee.userId} value={assignee.userId}>
                    {assignee.name}
                  </option>
                ))}
              </select>
            ) : null}
            {action === 'add_tags' || action === 'remove_tags' ? (
              <select
                aria-label={m.crm.tags}
                className={`${inputClass} w-auto`}
                value={argument}
                onChange={(event) => setArgument(event.target.value)}
              >
                <option value="">—</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            ) : null}
            {action === 'set_lifecycle' ? (
              <select
                aria-label={m.crm.lifecycle.label}
                className={`${inputClass} w-auto`}
                value={argument}
                onChange={(event) => setArgument(event.target.value)}
              >
                <option value="">—</option>
                {LIFECYCLE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {m.crm.lifecycle[stage]}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onClick={apply}
              loading={pending}
              disabled={!action}
            >
              {m.crm.apply}
            </Button>
          </>
        ) : null}
        {canDelete ? (
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            {m.crm.bulkDelete}
          </Button>
        ) : null}
      </div>
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error && !confirmDelete ? <Alert tone="error">{error.message}</Alert> : null}
      <ConfirmDialog
        open={confirmDelete}
        title={m.crm.bulkDelete}
        message={format(m.crm.bulkDeleteConfirm, { count: String(ids.length) })}
        confirmLabel={m.crm.delete}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void submit({ action: 'delete' })}
      />
    </div>
  );
}
