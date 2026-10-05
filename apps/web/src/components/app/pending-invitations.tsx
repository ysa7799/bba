'use client';

import { useMessages } from '@/components/i18n-provider';
import { Card } from '@/components/ui/card';
import { apiRequest } from '@/lib/api-client';
import type { PendingInvitation } from '@/lib/api-types';
import { useOrg } from './org-access';
import { useMutation } from './use-mutation';

export function PendingInvitations({ invitations }: { invitations: PendingInvitation[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.app.members.pending}</h2>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {error.message}
        </p>
      ) : null}
      {invitations.length === 0 ? (
        <p className="text-sm text-slate-500">{m.app.members.noPending}</p>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="font-medium text-slate-900">{invitation.email}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {invitation.roleName}
                </span>
                <span className="text-slate-500">
                  {m.app.members.expires} {dateFormat.format(new Date(invitation.expiresAt))}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  className="ms-auto text-sm text-red-600 hover:text-red-700"
                  onClick={() =>
                    void run(() =>
                      apiRequest(`/app/orgs/${organizationId}/invitations/${invitation.id}`, {
                        method: 'DELETE',
                      }),
                    )
                  }
                >
                  {m.app.members.revoke}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
