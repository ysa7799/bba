'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMessages } from '@/components/i18n-provider';
import { Card } from '@/components/ui/card';
import type { Assignee, CompanySummary, TagSummary } from '@/lib/crm-types';
import { BulkBar } from './bulk-bar';
import { TagList } from './tag-badge';

export function CompaniesTable({
  companies,
  tags,
  assignees,
}: {
  companies: CompanySummary[];
  tags: TagSummary[];
  assignees: Assignee[];
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = companies.length > 0 && selected.length === companies.length;
  return (
    <>
      <BulkBar
        entity="companies"
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
                    setSelected(allSelected ? [] : companies.map((company) => company.id))
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.companies.name}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.companies.domain}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.companies.industry}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.companies.city}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.companies.contacts}
              </th>
              <th scope="col" className="px-4 py-2 text-start">
                {m.crm.owner}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {companies.map((company) => (
              <tr
                key={company.id}
                className={selected.includes(company.id) ? 'bg-brand-50' : undefined}
              >
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${company.name}`}
                    checked={selected.includes(company.id)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(company.id)
                          ? current.filter((id) => id !== company.id)
                          : [...current, company.id],
                      )
                    }
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/o/${organizationId}/crm/companies/${company.id}`}
                    className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                  >
                    {company.name}
                  </Link>
                  <div className="mt-1">
                    <TagList tags={company.tags} />
                  </div>
                </td>
                <td className="px-4 py-2 text-slate-600">{company.domain ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600">{company.industry ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600">{company.city ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600">{company.contactCount}</td>
                <td className="px-4 py-2 text-slate-600">{company.ownerName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
