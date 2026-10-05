'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { TRIGGER_TYPES, type TriggerType, type WorkflowDetail } from '@/lib/automation-types';

export function NewWorkflowButton() {
  const m = useMessages();
  const a = m.automation;
  const router = useRouter();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<TriggerType>('contact.created');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let id: string | null = null;
    const ok = await run(
      async () => {
        id = (
          await apiRequest<{ workflow: WorkflowDetail }>(
            `/app/orgs/${organizationId}/automation/workflows`,
            { body: { name, triggerType } },
          )
        ).workflow.id;
      },
      { refresh: false },
    );
    const created = id as string | null;
    if (ok && created) router.push(`/o/${organizationId}/automation/${created}`);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{a.newWorkflow}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={a.newWorkflow}>
        <form onSubmit={submit} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={a.name}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            autoFocus
          />
          <SelectField
            label={a.startWith}
            value={triggerType}
            onChange={(event) => setTriggerType(event.target.value as TriggerType)}
          >
            {TRIGGER_TYPES.map((type) => (
              <option key={type} value={type}>
                {a.triggers[type]}
              </option>
            ))}
          </SelectField>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {a.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Pause/resume, archive and details of a workflow. */
export function WorkflowActions({ workflow }: { workflow: WorkflowDetail }) {
  const m = useMessages();
  const a = m.automation;
  const { organizationId } = useOrg();
  const canManage = useCan('automation.workflow.manage');
  const { run, pending, error } = useMutation();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const base = `/app/orgs/${organizationId}/automation/workflows/${workflow.id}`;
  if (!canManage || workflow.status === 'archived') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => setEditing(true)}>
        {a.details}
      </Button>
      {workflow.status === 'active' || workflow.status === 'paused' ? (
        <Button
          variant="secondary"
          loading={pending}
          onClick={() =>
            void run(() =>
              apiRequest(`${base}/${workflow.status === 'active' ? 'pause' : 'resume'}`, {
                method: 'POST',
              }),
            )
          }
        >
          {workflow.status === 'active' ? a.pause : a.resume}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={() => setArchiving(true)}>
        {a.archive}
      </Button>
      {error && !archiving ? <Alert tone="error">{error.message}</Alert> : null}
      {editing ? <DetailsDialog workflow={workflow} onClose={() => setEditing(false)} /> : null}
      <ConfirmDialog
        open={archiving}
        title={a.archive}
        message={a.archiveConfirm}
        confirmLabel={a.archive}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onConfirm={() =>
          void run(() => apiRequest(`${base}/archive`, { method: 'POST' })).then((ok) => {
            if (ok) setArchiving(false);
          })
        }
        onClose={() => setArchiving(false)}
      />
    </div>
  );
}

function DetailsDialog({ workflow, onClose }: { workflow: WorkflowDetail; onClose: () => void }) {
  const m = useMessages();
  const a = m.automation;
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? '');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/automation/workflows/${workflow.id}`, {
        method: 'PATCH',
        body: { name, description: description.trim() || null },
      }),
    );
    if (ok) onClose();
  }

  return (
    <Dialog open onClose={onClose} title={a.details}>
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <TextField
          label={a.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
        />
        <TextAreaField
          label={a.description}
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={1_000}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {a.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Inbound webhook URL of a webhook-triggered workflow (shown once after creating it). */
export function WebhookPanel({ workflow }: { workflow: WorkflowDetail }) {
  const m = useMessages();
  const a = m.automation;
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    let created: string | null = null;
    const ok = await run(
      async () => {
        created = (
          await apiRequest<{ url: string }>(
            `/app/orgs/${organizationId}/automation/workflows/${workflow.id}/webhook-token`,
            { method: 'POST' },
          )
        ).url;
      },
      { refresh: false },
    );
    if (ok) {
      setUrl(created);
      setCopied(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {url ? (
        <>
          <pre
            className="overflow-x-auto rounded-md bg-slate-100 p-2 font-mono text-xs text-slate-800"
            data-testid="webhook-url"
          >
            {url}
          </pre>
          <p className="text-xs text-slate-500">{a.webhookShownOnce}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
          >
            {copied ? a.copied : a.copy}
          </Button>
        </>
      ) : workflow.webhookConfigured ? (
        <p className="text-xs text-slate-500">{a.webhookConfigured}</p>
      ) : null}
      <Button variant="secondary" size="sm" loading={pending} onClick={() => void generate()}>
        {workflow.webhookConfigured || url ? a.webhookRegenerate : a.webhookGenerate}
      </Button>
    </div>
  );
}
