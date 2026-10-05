'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMessages } from '@/components/i18n-provider';
import { Card } from '@/components/ui/card';
import type { Assignee, ContactSummary, TagSummary } from '@/lib/crm-types';
import { formatDate } from '@/lib/format';
import { BulkBar } from './bulk-bar';
import { TagList } from './tag-badge';

export function ContactsTable({
  contacts,
  tags,
  assignees,
}: {
  contacts: ContactSummary[];
  tags: TagSummary[];
  assignees: Assignee[];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = contacts.length > 0 && selected.length === contacts.length;
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  return (
    <>
      <BulkBar
        entity="contacts"
        ids={selected}
        tags={tags}
        assignees={assignees}
        onDone={() => setSelected([])}
      />
      <Card className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs font-medium uppercase text-slate-500">
            <tr>
              <th scope="col" className="w-10 px-4 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? [] : contacts.map((contact) => contact.id))
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.contacts.name}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.contacts.email}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.contacts.phone}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.contacts.company}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.lifecycle.label}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.owner}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.created}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contacts.map((contact) => (
              <tr
                key={contact.id}
                className={selected.includes(contact.id) ? 'bg-brand-50' : undefined}
              >
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${contact.displayName}`}
                    checked={selected.includes(contact.id)}
                    onChange={() => toggle(contact.id)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/o/${organizationId}/crm/contacts/${contact.id}`}
                    className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                  >
                    {contact.displayName}
                  </Link>
                  {contact.jobTitle ? (
                    <div className="text-xs text-slate-500">{contact.jobTitle}</div>
                  ) : null}
                  <div className="mt-1">
                    <TagList tags={contact.tags} />
                  </div>
                </td>
                <td className="px-4 py-2 text-slate-600">{contact.email ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600" dir="ltr">
                  {contact.phone ?? '—'}
                </td>
                <td className="px-4 py-2 text-slate-600">
                  {contact.primaryCompany ? (
                    <Link
                      href={`/o/${organizationId}/crm/companies/${contact.primaryCompany.id}`}
                      className="hover:underline"
                    >
                      {contact.primaryCompany.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2 text-slate-600">
                  {m.crm.lifecycle[contact.lifecycleStage]}
                </td>
                <td className="px-4 py-2 text-slate-600">{contact.ownerName ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600">{formatDate(contact.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
