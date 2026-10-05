import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { WebhookPanel, WorkflowActions } from '@/components/automation/workflow-actions';
import { WorkflowBuilder } from '@/components/automation/workflow-builder';
import { StatusBadge, WorkflowTabs } from '@/components/automation/workflow-tabs';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { AutomationOptions, WorkflowDetail } from '@/lib/automation-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ orgId: string; workflowId: string }>;
}) {
  const { orgId, workflowId } = await params;
  const m = getMessages('en');
  const a = m.automation;
  const access = await getOrgAccess(orgId);
  if (!access || !UUID.test(workflowId)) notFound();
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('automation.workflow.read'))
    return <CrmForbidden title={a.title} message={a.forbidden} />;
  const base = `/app/orgs/${orgId}/automation`;
  const [detail, options] = await Promise.all([
    serverGetJson<{ workflow: WorkflowDetail }>(`${base}/workflows/${workflowId}`),
    can('automation.workflow.manage')
      ? serverGetJson<AutomationOptions>(`${base}/builder-options`)
      : Promise.resolve(null),
  ]);
  if (!detail) notFound();
  const { workflow } = detail;
  const editing = workflow.draft ?? workflow.published;
  const trigger = editing?.definition.trigger.type ?? workflow.triggerType;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <Link href={`/o/${orgId}/automation`} className="text-sm text-slate-600 hover:underline">
        {a.backToWorkflows}
      </Link>
      <PageHeader
        title={workflow.name}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={workflow.status} label={a.status[workflow.status]} />
            {workflow.publishedVersion !== null ? (
              <span className="text-xs text-slate-500">
                {format(a.version, { number: String(workflow.publishedVersion) })}
              </span>
            ) : null}
            <WorkflowActions workflow={workflow} />
          </div>
        }
      />
      <WorkflowTabs orgId={orgId} workflowId={workflow.id} current="builder" />
      <div className="space-y-6">
        {workflow.description ? (
          <p className="text-sm text-slate-600">{workflow.description}</p>
        ) : null}
        {trigger === 'webhook.received' && options && workflow.status !== 'archived' ? (
          <Section title={a.webhookUrl}>
            <WebhookPanel workflow={workflow} />
          </Section>
        ) : null}
        {options && editing && workflow.status !== 'archived' ? (
          <WorkflowBuilder workflow={workflow} source={editing} options={options} />
        ) : editing ? (
          <Section title={a.steps}>
            <p className="mb-2 text-sm text-slate-700">
              {a.triggers[editing.definition.trigger.type]}
            </p>
            <ol className="list-inside list-decimal space-y-1 text-sm text-slate-700">
              {editing.definition.nodes.map((node) => (
                <li key={node.key}>
                  {node.label ??
                    (node.type === 'action' && node.action
                      ? a.actions[node.action]
                      : a.stepKinds[node.type])}
                </li>
              ))}
            </ol>
          </Section>
        ) : null}
      </div>
    </OrgAccessBoundary>
  );
}
