import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { FormBuilder } from '@/components/forms/form-builder';
import { FormHeaderActions, SharePanel } from '@/components/forms/form-header';
import { FormTabs } from '@/components/forms/form-tabs';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { BuilderOptions, FormDetail } from '@/lib/forms-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function FormPage({
  params,
}: {
  params: Promise<{ orgId: string; formId: string }>;
}) {
  const { orgId, formId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access || !UUID.test(formId)) notFound();
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('forms.read')) return <CrmForbidden title={m.forms.title} message={m.forms.forbidden} />;
  const base = `/app/orgs/${orgId}/forms`;
  const [detail, options] = await Promise.all([
    serverGetJson<{ form: FormDetail }>(`${base}/${formId}`),
    can('forms.manage')
      ? serverGetJson<BuilderOptions>(`${base}/builder-options`)
      : Promise.resolve(null),
  ]);
  if (!detail) notFound();
  const { form } = detail;
  const editable = options !== null && form.status === 'active';
  const shown = form.published ?? form.draft;
  const editing = form.draft ?? form.published;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <Link href={`/o/${orgId}/forms`} className="text-sm text-slate-600 hover:underline">
        {m.forms.backToForms}
      </Link>
      <PageHeader title={form.name} actions={<FormHeaderActions form={form} />} />
      <FormTabs
        orgId={orgId}
        formId={form.id}
        current="builder"
        showSubmissions={can('forms.submission.read')}
      />
      <div className="space-y-6">
        {form.status === 'archived' ? <Alert tone="info">{m.forms.archiveConfirm}</Alert> : null}
        {form.published && form.status === 'active' ? (
          <Section title={m.forms.share}>
            <SharePanel form={form} />
          </Section>
        ) : null}
        {editable && editing ? (
          <FormBuilder form={form} source={editing} options={options} />
        ) : shown ? (
          <Section
            title={`${m.forms.fields} · ${format(m.forms.version, { number: String(shown.number) })}`}
          >
            <ul className="divide-y divide-slate-100 text-sm">
              {shown.fields.map((field) => (
                <li key={field.key} className="flex justify-between gap-3 py-2">
                  <span className="text-slate-900">
                    {field.label}
                    {field.required ? ' *' : ''}
                  </span>
                  <span className="text-slate-500">{m.forms.types[field.type]}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </OrgAccessBoundary>
  );
}
