import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CompanyFormDialog } from '@/components/crm/company-form';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { CustomFieldValues } from '@/components/crm/custom-field-inputs';
import { DeleteRecordButton } from '@/components/crm/delete-record-button';
import { DetailList, Section } from '@/components/crm/detail';
import { NotesPanel } from '@/components/crm/notes-panel';
import { TagList } from '@/components/crm/tag-badge';
import { NewTaskButton, TaskList } from '@/components/crm/task-list';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { crmFormOptions } from '@/lib/crm-server';
import type {
  CompanySummary,
  ContactSummary,
  DealSummary,
  NoteSummary,
  TaskSummary,
} from '@/lib/crm-types';
import { formatDate, formatMoney } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ orgId: string; companyId: string }>;
}) {
  const { orgId, companyId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('crm.company.read')) return <CrmForbidden title={m.crm.companies.title} />;
  const base = `/app/orgs/${orgId}/crm`;
  const [company, notes, contacts, deals, tasks, options] = await Promise.all([
    serverGetJson<{ company: CompanySummary }>(`${base}/companies/${companyId}`),
    serverGetJson<Page<NoteSummary>>(`${base}/companies/${companyId}/notes?limit=50`),
    can('crm.contact.read')
      ? serverGetJson<Page<ContactSummary>>(
          `${base}/contacts?companyId=${companyId}&limit=50&sort=name_asc`,
        )
      : Promise.resolve(null),
    can('crm.deal.read')
      ? serverGetJson<Page<DealSummary>>(`${base}/deals?companyId=${companyId}&limit=50`)
      : Promise.resolve(null),
    can('crm.task.read')
      ? serverGetJson<Page<TaskSummary>>(`${base}/tasks?companyId=${companyId}&limit=50`)
      : Promise.resolve(null),
    crmFormOptions(orgId, 'company'),
  ]);
  if (!company) notFound();
  const c = company.company;
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <nav className="mb-2 text-sm">
        <Link href={`/o/${orgId}/crm/companies`} className="text-slate-500 hover:underline">
          ← {m.crm.companies.title}
        </Link>
      </nav>
      <PageHeader
        title={c.name}
        actions={
          <div className="flex gap-2">
            {can('crm.company.update') ? (
              <CompanyFormDialog
                company={c}
                options={options}
                buttonLabel={m.crm.edit}
                buttonVariant="secondary"
              />
            ) : null}
            {can('crm.company.delete') ? (
              <DeleteRecordButton
                path={`${base}/companies/${c.id}`}
                title={m.crm.delete}
                message={format(m.crm.companies.deleteConfirm, { name: c.name })}
                redirectTo={`/o/${orgId}/crm/companies`}
              />
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section title={m.crm.details}>
            <DetailList
              items={[
                [m.crm.companies.domain, c.domain],
                [
                  m.crm.companies.website,
                  c.website ? (
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-brand-700 hover:underline"
                    >
                      {c.website}
                    </a>
                  ) : null,
                ],
                [m.crm.companies.phone, c.phone],
                [m.crm.companies.industry, c.industry],
                [
                  m.crm.companies.employees,
                  c.employeeCount === null ? null : String(c.employeeCount),
                ],
                [m.crm.companies.city, [c.city, c.countryCode].filter(Boolean).join(', ') || null],
                [m.crm.owner, c.ownerName],
                [m.crm.tags, c.tags.length > 0 ? <TagList tags={c.tags} /> : null],
                [m.crm.created, formatDate(c.createdAt)],
              ]}
            />
          </Section>
          {options.fields.length > 0 ? (
            <Section title={m.crm.customFields}>
              <CustomFieldValues
                fields={options.fields}
                values={c.customFields}
                assignees={options.assignees}
              />
            </Section>
          ) : null}
          {contacts ? (
            <Section title={m.crm.companies.contacts}>
              {contacts.data.length === 0 ? (
                <p className="text-sm text-slate-500">—</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {contacts.data.map((contact) => (
                    <li key={contact.id} className="flex justify-between gap-2 py-2">
                      <Link
                        href={`/o/${orgId}/crm/contacts/${contact.id}`}
                        className="font-medium hover:underline"
                      >
                        {contact.displayName}
                      </Link>
                      <span className="text-slate-600">
                        {contact.jobTitle ?? contact.email ?? ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
          {deals ? (
            <Section title={m.crm.deals.title}>
              {deals.data.length === 0 ? (
                <p className="text-sm text-slate-500">—</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {deals.data.map((deal) => (
                    <li key={deal.id} className="flex justify-between gap-2 py-2">
                      <Link
                        href={`/o/${orgId}/crm/deals/${deal.id}`}
                        className="font-medium hover:underline"
                      >
                        {deal.name}
                      </Link>
                      <span className="text-slate-600">
                        {deal.stageName}
                        {deal.value ? ` · ${formatMoney(deal.value)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
        </div>
        <div className="space-y-6 lg:col-span-2">
          <NotesPanel
            parentPath={`companies/${c.id}`}
            notes={notes?.data ?? []}
            currentUserId={me.user.id}
          />
          {tasks ? (
            <Section
              title={m.crm.tasks.title}
              actions={<NewTaskButton assignees={options.assignees} link={{ companyId: c.id }} />}
            >
              <TaskList tasks={tasks.data} timezone={timezone} />
            </Section>
          ) : null}
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
