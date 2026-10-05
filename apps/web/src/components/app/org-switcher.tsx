'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { apiRequest } from '@/lib/api-client';
import type { OrganizationSummary } from '@/lib/api-types';

const NEW_ORG = '__new__';

export function OrgSwitcher({
  organizations,
  currentId,
}: {
  organizations: OrganizationSummary[];
  currentId: string;
}) {
  const m = useMessages();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onChange(value: string) {
    if (value === NEW_ORG) {
      router.push('/onboarding');
      return;
    }
    setPending(true);
    try {
      await apiRequest('/app/me/active-organization', { body: { organizationId: value } });
    } finally {
      router.push(`/o/${value}`);
      setPending(false);
    }
  }

  return (
    <label className="block">
      <span className="sr-only">{m.app.switchOrganization}</span>
      <select
        value={currentId}
        disabled={pending}
        onChange={(event) => void onChange(event.target.value)}
        className="w-full rounded-md border-0 bg-slate-800 py-1.5 ps-2 pe-8 text-sm font-medium text-white ring-1 ring-slate-700 focus:ring-2 focus:ring-brand-500"
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
        <option value={NEW_ORG}>+ {m.app.createOrganization}</option>
      </select>
    </label>
  );
}
