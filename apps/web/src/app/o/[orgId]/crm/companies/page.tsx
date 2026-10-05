import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CompaniesTable } from '@/components/crm/companies-table';
import { CompanyFormDialog } from '@/components/crm/company-form';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { ExportButton } from '@/components/crm/export-button';
import { FilterSelect, ListFilters, NextPageLink } from '@/components/crm/list-filters';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { crmFormOptions, pickFilters } from '@/lib/crm-server';
import type { CompanySummary } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const FILTERS = ['q', 'tagId', 'ownerUserId', 'sort'] as const;

export default async function CompaniesPage({
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
  if (!access.permissions.includes('crm.company.read'))
    return <CrmForbidden title={m.crm.companies.title} />;
  const filters = pickFilters(query, FILTERS);
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const qs = new URLSearchParams({ ...filters, limit: '25', ...(cursor ? { cursor } : {}) });
  const [page, options] = await Promise.all([
    serverGetJson<Page<CompanySummary>>(`/app/orgs/${orgId}/crm/companies?${qs.toString()}`),
    crmFormOptions(orgId, 'company'),
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
        title={m.crm.companies.title}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportButton entityType="company" filters={exportFilters} />
            {access.permissions.includes('crm.company.create') ? (
              <CompanyFormDialog options={options} buttonLabel={m.crm.companies.new} />
            ) : null}
          </div>
        }
      />
      <ListFilters q={filters.q ?? ''} clearHref={`/o/${orgId}/crm/companies`}>
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
          value={filters.sort ?? 'name_asc'}
          options={(
            ['name_asc', 'name_desc', 'created_desc', 'created_asc', 'updated_desc'] as const
          ).map((sort) => ({
            value: sort,
            label: m.crm.sorts[sort],
          }))}
        />
      </ListFilters>
      {page.data.length === 0 ? (
        <EmptyState title={filtered ? m.crm.companies.noMatch : m.crm.companies.empty} />
      ) : (
        <CompaniesTable companies={page.data} tags={options.tags} assignees={options.assignees} />
      )}
      <NextPageLink href={nextHref} />
    </OrgAccessBoundary>
  );
}
