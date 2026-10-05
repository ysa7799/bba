'use client';

import { useState } from 'react';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { ConfirmDialog } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';
import type { MemberSummary, RoleSummary } from '@/lib/api-types';
import { useOrg } from './org-access';
import { useMutation } from './use-mutation';

/** Per-member controls; only rendered for users with `settings.users.manage`. */
export function MemberActions({ member, roles }: { member: MemberSummary; roles: RoleSummary[] }) {
  const m = useMessages();
  const { organizationId, access } = useOrg();
  const { run, pending, error } = useMutation();
  const [confirming, setConfirming] = useState(false);
  const isSelf = member.membershipId === access.membershipId;
  const currentRole = member.roles[0]?.id ?? '';
  const base = `/app/orgs/${organizationId}/members/${member.membershipId}`;
  const assignable = roles.filter((role) => role.systemKey !== 'owner' || access.isOwner);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`role-${member.membershipId}`}>
        {m.app.members.changeRole}
      </label>
      <select
        id={`role-${member.membershipId}`}
        value={currentRole}
        disabled={pending}
        onChange={(event) =>
          void run(() =>
            apiRequest(`${base}/roles`, { method: 'PUT', body: { roleIds: [event.target.value] } }),
          )
        }
        className="rounded-md border-0 py-1 ps-2 pe-7 text-sm ring-1 ring-inset ring-slate-300"
      >
        {member.roles.length === 0 ? <option value="">—</option> : null}
        {assignable.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      {!isSelf ? (
        <>
          <button
            type="button"
            disabled={pending}
            className="text-sm text-slate-600 hover:text-slate-900"
            onClick={() =>
              void run(() =>
                apiRequest(base, {
                  method: 'PATCH',
                  body: { status: member.status === 'active' ? 'suspended' : 'active' },
                }),
              )
            }
          >
            {member.status === 'active' ? m.app.members.suspend : m.app.members.reactivate}
          </button>
          <button
            type="button"
            disabled={pending}
            className="text-sm text-red-600 hover:text-red-700"
            onClick={() => setConfirming(true)}
          >
            {m.app.members.remove}
          </button>
        </>
      ) : null}
      {error && !confirming ? (
        <span role="alert" className="w-full text-xs text-red-600">
          {error.message}
        </span>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={m.app.members.remove}
        message={format(m.app.members.removeConfirm, { name: member.name })}
        confirmLabel={m.app.members.remove}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          if (await run(() => apiRequest(base, { method: 'DELETE' }))) setConfirming(false);
        }}
      />
    </div>
  );
}
