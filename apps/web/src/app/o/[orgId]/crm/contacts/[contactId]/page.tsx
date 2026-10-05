import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CompanyLinks } from '@/components/crm/company-links';
import { ContactFormDialog } from '@/components/crm/contact-form';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { CustomFieldValues } from '@/components/crm/custom-field-inputs';
import { DeleteRecordButton } from '@/components/crm/delete-record-button';
import { DetailList, Section, whatsappHref } from '@/components/crm/detail';
import { NotesPanel } from '@/components/crm/notes-panel';
import { TagList } from '@/components/crm/tag-badge';
import { NewTaskButton, TaskList } from '@/components/crm/task-list';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { crmFormOptions } from '@/lib/crm-server';
import type { ContactDetail, DealSummary, NoteSummary, TaskSummary } from '@/lib/crm-types';
import { formatDate, formatMoney } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function ContactPage({
  params,
}: {
  params: Promise<{ orgId: string; contactId: string }>;
}) {
  const { orgId, contactId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('crm.contact.read')) return <CrmForbidden title={m.crm.contacts.title} />;
  const base = `/app/orgs/${orgId}/crm`;
  const [contact, notes, tasks, deals, options] = await Promise.all([
    serverGetJson<{ contact: ContactDetail }>(`${base}/contacts/${contactId}`),
    serverGetJson<Page<NoteSummary>>(`${base}/contacts/${contactId}/notes?limit=50`),
    can('crm.task.read')
      ? serverGetJson<Page<TaskSummary>>(`${base}/tasks?contactId=${contactId}&limit=50`)
      : Promise.resolve(null),
    can('crm.deal.read')
      ? serverGetJson<Page<DealSummary>>(`${base}/deals?contactId=${contactId}&limit=50`)
      : Promise.resolve(null),
    crmFormOptions(orgId, 'contact'),
  ]);
  if (!contact) notFound();
  const c = contact.contact;
  const organization = me.organizations.find((entry) => entry.id === orgId);
  const timezone = organization?.timezone ?? 'Asia/Bahrain';

  return (
    <OrgAccessBoundary orgId={orgId}>
      <nav className="mb-2 text-sm">
        <Link href={`/o/${orgId}/crm/contacts`} className="text-slate-500 hover:underline">
          ← {m.crm.contacts.title}
        </Link>
      </nav>
      <PageHeader
        title={c.displayName}
        actions={
          <div className="flex gap-2">
            {can('crm.contact.update') ? (
              <ContactFormDialog
                contact={c}
                options={options}
                buttonLabel={m.crm.edit}
                buttonVariant="secondary"
              />
            ) : null}
            {can('crm.contact.delete') ? (
              <DeleteRecordButton
                path={`${base}/contacts/${c.id}`}
                title={m.crm.delete}
                message={format(m.crm.contacts.deleteConfirm, { name: c.displayName })}
                redirectTo={`/o/${orgId}/crm/contacts`}
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
                [
                  m.crm.contacts.email,
                  c.email ? (
                    <a href={`mailto:${c.email}`} className="text-brand-700 hover:underline">
                      {c.email}
                    </a>
                  ) : null,
                ],
                [
                  m.crm.contacts.phone,
                  c.phone ? (
                    <a href={`tel:${c.phone}`} dir="ltr" className="text-brand-700 hover:underline">
                      {c.phone}
                    </a>
                  ) : null,
                ],
                [
                  m.crm.contacts.whatsapp,
                  c.whatsappPhone ? (
                    <a
                      href={whatsappHref(c.whatsappPhone)}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="ltr"
                      className="text-brand-700 hover:underline"
                    >
                      {c.whatsappPhone}
                    </a>
                  ) : null,
                ],
                [m.crm.contacts.jobTitle, c.jobTitle],
                [m.crm.lifecycle.label, m.crm.lifecycle[c.lifecycleStage]],
                [
                  m.crm.contacts.status,
                  c.status === 'active' ? m.crm.contacts.active : m.crm.contacts.inactive,
                ],
                [m.crm.owner, c.ownerName],
                [m.crm.contacts.source, c.source],
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
          {can('crm.company.read') ? (
            <Section title={m.crm.contacts.companies}>
              <CompanyLinks contact={c} />
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
            parentPath={`contacts/${c.id}`}
            notes={notes?.data ?? []}
            currentUserId={me.user.id}
          />
          {tasks ? (
            <Section
              title={m.crm.tasks.title}
              actions={<NewTaskButton assignees={options.assignees} link={{ contactId: c.id }} />}
            >
              <TaskList tasks={tasks.data} timezone={timezone} />
            </Section>
          ) : null}
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
