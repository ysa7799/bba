'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { ContactDetail } from '@/lib/crm-types';
import { RecordPicker, type PickedRecord } from './record-picker';

/** A contact's companies with link/unlink controls. */
export function CompanyLinks({ contact }: { contact: ContactDetail }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canUpdate = useCan('crm.contact.update');
  const canReadCompanies = useCan('crm.company.read');
  const canEdit = canUpdate && canReadCompanies;
  const [company, setCompany] = useState<PickedRecord | null>(null);
  const [role, setRole] = useState('');
  const [primary, setPrimary] = useState(contact.companies.length === 0);
  const { run, pending, error } = useMutation();
  const base = `/app/orgs/${organizationId}/crm/contacts/${contact.id}/companies`;

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {contact.companies.length === 0 ? (
        <p className="text-sm text-slate-500">—</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {contact.companies.map((link) => (
            <li key={link.companyId} className="flex items-center justify-between gap-2">
              <span>
                <Link
                  href={`/o/${organizationId}/crm/companies/${link.companyId}`}
                  className="font-medium hover:underline"
                >
                  {link.name}
                </Link>
                {link.role ? <span className="text-slate-500"> · {link.role}</span> : null}
                {link.isPrimary ? (
                  <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {m.crm.contacts.primary}
                  </span>
                ) : null}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  className="text-xs font-medium text-slate-500 hover:text-red-700"
                  onClick={() =>
                    void run(() => apiRequest(`${base}/${link.companyId}`, { method: 'DELETE' }))
                  }
                >
                  {m.crm.contacts.unlink}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="space-y-2 rounded-md border border-dashed border-slate-300 p-3">
          <RecordPicker
            label={m.crm.contacts.addCompany}
            type="company"
            value={company}
            onChange={setCompany}
          />
          {company ? (
            <>
              <TextField
                label={m.crm.contacts.role}
                value={role}
                onChange={(event) => setRole(event.target.value)}
              />
              <CheckboxField
                label={m.crm.contacts.makePrimary}
                checked={primary}
                onChange={(event) => setPrimary(event.target.checked)}
              />
              <Button
                size="sm"
                loading={pending}
                onClick={() =>
                  void run(() =>
                    apiRequest(base, { body: { companyId: company.id, role, isPrimary: primary } }),
                  ).then((ok) => {
                    if (ok) {
                      setCompany(null);
                      setRole('');
                    }
                  })
                }
              >
                {m.crm.contacts.addCompany}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
