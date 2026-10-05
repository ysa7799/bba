'use client';

import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { RoleSummary } from '@/lib/api-types';
import { useOrg } from './org-access';
import { useMutation } from './use-mutation';

export function InviteMemberDialog({ roles }: { roles: RoleSummary[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const assignable = roles.filter((role) => role.systemKey !== 'owner');
  const defaultRole = assignable.find((role) => role.systemKey === 'member') ?? assignable[0];
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(defaultRole?.id ?? '');
  const { run, pending, error, reset } = useMutation();

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/invitations`, { body: { email, roleId } }),
    );
    if (ok) {
      setEmail('');
      setOpen(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {m.app.members.invite}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={m.app.members.inviteTitle}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <TextField
            label={m.auth.email}
            type="email"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={error?.fieldError('email')}
          />
          <SelectField
            label={m.app.members.role}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            {assignable.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </SelectField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.app.members.inviteSubmit}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
