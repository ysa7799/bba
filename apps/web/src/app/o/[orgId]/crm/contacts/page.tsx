import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { ContactFormDialog } from '@/components/crm/contact-form';
import { ContactsTable } from '@/components/crm/contacts-table';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { ExportButton } from '@/components/crm/export-button';
import { FilterSelect, ListFilters, NextPageLink } from '@/components/crm/list-filters';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { crmFormOptions, pickFilters } from '@/lib/crm-server';
import { LIFECYCLE_STAGES, type ContactSummary } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const FILTERS = ['q', 'lifecycleStage', 'status', 'tagId', 'ownerUserId', 'sort'] as const;

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('crm.contact.read'))
    return <CrmForbidden title={m.crm.contacts.title} />;

  const filters = pickFilters(query, FILTERS);
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const qs = new URLSearchParams({ ...filters, limit: '25', ...(cursor ? { cursor } : {}) });
  const [page, options] = await Promise.all([
    serverGetJson<Page<ContactSummary>>(`/app/orgs/${orgId}/crm/contacts?${qs.toString()}`),
    crmFormOptions(orgId, 'contact'),
  ]);
  if (!page) notFound();
  const filtered = Object.keys(filters).some((key) => key !== 'sort');
  const nextHref = page.nextCursor
    ? `?${new URLSearchParams({ ...filters, cursor: page.nextCursor }).toString()}`
    : null;
  const { sort: _sort, ...exportFilters } = filters;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.crm.contacts.title}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportButton entityType="contact" filters={exportFilters} />
            {access.permissions.includes('crm.contact.create') ? (
              <ContactFormDialog options={options} buttonLabel={m.crm.contacts.new} />
            ) : null}
          </div>
        }
      />
      <ListFilters q={filters.q ?? ''} clearHref={`/o/${orgId}/crm/contacts`}>
        <FilterSelect
          name="lifecycleStage"
          label={m.crm.lifecycle.label}
          value={filters.lifecycleStage ?? ''}
          options={[
            { value: '', label: m.crm.all },
            ...LIFECYCLE_STAGES.map((stage) => ({ value: stage, label: m.crm.lifecycle[stage] })),
          ]}
        />
        <FilterSelect
          name="status"
          label={m.crm.contacts.status}
          value={filters.status ?? ''}
          options={[
            { value: '', label: m.crm.all },
            { value: 'active', label: m.crm.contacts.active },
            { value: 'inactive', label: m.crm.contacts.inactive },
          ]}
        />
        <FilterSelect
          name="tagId"
          label={m.crm.tags}
          value={filters.tagId ?? ''}
          options={[
            { value: '', label: m.crm.all },
            ...options.tags.map((tag) => ({ value: tag.id, label: tag.name })),
          ]}
        />
        <FilterSelect
          name="ownerUserId"
          label={m.crm.owner}
          value={filters.ownerUserId ?? ''}
          options={[
            { value: '', label: m.crm.all },
            { value: 'me', label: m.crm.mine },
            { value: 'none', label: m.crm.unassigned },
            ...options.assignees.map((assignee) => ({
              value: assignee.userId,
              label: assignee.name,
            })),
          ]}
        />
        <FilterSelect
          name="sort"
          label={m.crm.sort}
          value={filters.sort ?? 'created_desc'}
          options={(
            ['created_desc', 'created_asc', 'updated_desc', 'name_asc', 'name_desc'] as const
          ).map((sort) => ({
            value: sort,
            label: m.crm.sorts[sort],
          }))}
        />
      </ListFilters>
      {page.data.length === 0 ? (
        <EmptyState title={filtered ? m.crm.contacts.noMatch : m.crm.contacts.empty} />
      ) : (
        <ContactsTable contacts={page.data} tags={options.tags} assignees={options.assignees} />
      )}
      <NextPageLink href={nextHref} />
    </OrgAccessBoundary>
  );
}
