import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { DeleteRoleButton, RoleEditor } from '@/components/app/role-editor';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { PermissionDefinition, RoleSummary } from '@/lib/api-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function RolesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [roles, access, catalogue] = await Promise.all([
    serverGetJson<{ data: RoleSummary[] }>(`/app/orgs/${orgId}/roles`),
    getOrgAccess(orgId),
    serverGetJson<{ data: PermissionDefinition[] }>(`/app/orgs/${orgId}/permissions`),
  ]);
  if (!roles || !access || !catalogue) notFound();
  const canManage = access.permissions.includes('settings.roles.manage');
  const labels = new Map(catalogue.data.map((definition) => [definition.key, definition.label]));
  const m = getMessages('en');

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.app.roles.title}
        actions={canManage ? <RoleEditor catalogue={catalogue.data} /> : null}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.data.map((role) => (
          <Card key={role.id} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-900">{role.name}</h2>
                <p className="text-xs text-slate-500">
                  {role.isSystem ? m.app.roles.system : m.app.roles.custom} ·{' '}
                  {role.memberCount ?? 0} {m.app.roles.members}
                </p>
              </div>
              {canManage && !role.isSystem ? (
                <div className="flex gap-3">
                  <RoleEditor role={role} catalogue={catalogue.data} />
                  <DeleteRoleButton role={role} />
                </div>
              ) : null}
            </div>
            {role.description ? (
              <p className="mt-2 text-sm text-slate-600">{role.description}</p>
            ) : null}
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {role.permissions.length === 0 ? (
                <li className="text-xs text-slate-500">{m.app.roles.noPermissions}</li>
              ) : (
                role.permissions.map((permission) => (
                  <li
                    key={permission}
                    className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                  >
                    {labels.get(permission) ?? permission}
                  </li>
                ))
              )}
            </ul>
          </Card>
        ))}
      </div>
    </OrgAccessBoundary>
  );
}
