'use client';

import { useState, type SubmitEvent } from 'react';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { PermissionDefinition, RoleSummary } from '@/lib/api-types';
import { useOrg } from './org-access';
import { useMutation } from './use-mutation';

function groupByModule(definitions: PermissionDefinition[]): [string, PermissionDefinition[]][] {
  const groups = new Map<string, PermissionDefinition[]>();
  for (const definition of definitions) {
    const list = groups.get(definition.module) ?? [];
    list.push(definition);
    groups.set(definition.module, list);
  }
  return [...groups.entries()];
}

/** Create/edit dialog for custom roles. Permissions the editor lacks are shown but disabled. */
export function RoleEditor({
  role,
  catalogue,
}: {
  role?: RoleSummary;
  catalogue: PermissionDefinition[];
}) {
  const m = useMessages();
  const { organizationId, access } = useOrg();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const { run, pending, error, reset } = useMutation();
  const held = new Set(access.permissions);

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { name, description, permissions: [...selected] };
    const ok = await run(() =>
      role
        ? apiRequest(`/app/orgs/${organizationId}/roles/${role.id}`, { method: 'PATCH', body })
        : apiRequest(`/app/orgs/${organizationId}/roles`, { body }),
    );
    if (ok) {
      setOpen(false);
      if (!role) {
        setName('');
        setDescription('');
        setSelected(new Set());
      }
    }
  }

  return (
    <>
      {role ? (
        <button
          type="button"
          className="text-sm text-brand-600 hover:underline"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          {m.app.roles.edit}
        </button>
      ) : (
        <Button
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          {m.app.roles.create}
        </Button>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={role ? `${m.app.roles.edit}: ${role.name}` : m.app.roles.create}
      >
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <TextField
            label={m.app.roles.name}
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error?.fieldError('name')}
          />
          <TextField
            label={m.app.roles.description}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-800">
              {m.app.roles.permissions}
            </legend>
            <div className="max-h-72 space-y-4 overflow-y-auto rounded-md border border-slate-200 p-3">
              {groupByModule(catalogue).map(([module, definitions]) => (
                <div key={module}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {module}
                  </p>
                  {definitions.map((definition) => (
                    <label key={definition.key} className="flex items-start gap-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selected.has(definition.key)}
                        disabled={!held.has(definition.key)}
                        onChange={() => toggle(definition.key)}
                      />
                      <span>
                        <span className="font-medium text-slate-900">{definition.label}</span>
                        <span className="block text-xs text-slate-500">
                          {definition.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            {error?.fieldError('permissions') ? (
              <p className="mt-1 text-sm text-red-600">{error.fieldError('permissions')}</p>
            ) : null}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.app.roles.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function DeleteRoleButton({ role }: { role: RoleSummary }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const { run, pending, error, reset } = useMutation();
  return (
    <>
      <button
        type="button"
        className="text-sm text-red-600 hover:text-red-700"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {m.app.roles.delete}
      </button>
      <ConfirmDialog
        open={open}
        title={m.app.roles.delete}
        message={format(m.app.roles.deleteConfirm, { name: role.name })}
        confirmLabel={m.app.roles.delete}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const ok = await run(() =>
            apiRequest(`/app/orgs/${organizationId}/roles/${role.id}`, { method: 'DELETE' }),
          );
          if (ok) setOpen(false);
        }}
      />
    </>
  );
}
