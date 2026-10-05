'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Assignee, TaskSummary } from '@/lib/crm-types';
import { formatDateTime, fromDateTimeLocal } from '@/lib/format';

/** Task rows with a completion toggle; links to related records. */
export function TaskList({ tasks, timezone }: { tasks: TaskSummary[]; timezone: string }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('crm.task.manage');
  const { run, error } = useMutation();
  // Captured once per mount: "overdue" styling does not need to tick.
  const [now] = useState(() => Date.now());
  const base = `/o/${organizationId}/crm`;

  if (tasks.length === 0) return <p className="text-sm text-slate-500">{m.crm.tasks.empty}</p>;
  return (
    <div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <ul className="divide-y divide-slate-100">
        {tasks.map((task) => {
          const overdue =
            task.status === 'open' && task.dueAt !== null && new Date(task.dueAt).getTime() < now;
          return (
            <li key={task.id} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                aria-label={task.status === 'open' ? m.crm.tasks.complete : m.crm.tasks.reopen}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
                checked={task.status === 'completed'}
                disabled={!canManage}
                onChange={() =>
                  void run(() =>
                    apiRequest(`/app/orgs/${organizationId}/crm/tasks/${task.id}`, {
                      method: 'PATCH',
                      body: { status: task.status === 'open' ? 'completed' : 'open' },
                    }),
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-sm font-medium text-slate-900',
                    task.status === 'completed' && 'text-slate-400 line-through',
                  )}
                >
                  {task.title}
                  {task.priority === 'high' ? (
                    <span className="ms-2 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">
                      {m.crm.tasks.high}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500">
                  <span className={overdue ? 'font-medium text-red-600' : undefined}>
                    {task.dueAt ? formatDateTime(task.dueAt, timezone) : m.crm.tasks.noDue}
                  </span>
                  {task.assigneeName ? ` · ${task.assigneeName}` : ''}
                  {task.contact ? (
                    <>
                      {' · '}
                      <Link
                        href={`${base}/contacts/${task.contact.id}`}
                        className="hover:underline"
                      >
                        {task.contact.name}
                      </Link>
                    </>
                  ) : null}
                  {task.company ? (
                    <>
                      {' · '}
                      <Link
                        href={`${base}/companies/${task.company.id}`}
                        className="hover:underline"
                      >
                        {task.company.name}
                      </Link>
                    </>
                  ) : null}
                  {task.deal ? (
                    <>
                      {' · '}
                      <Link href={`${base}/deals/${task.deal.id}`} className="hover:underline">
                        {task.deal.name}
                      </Link>
                    </>
                  ) : null}
                </p>
                {task.description ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                    {task.description}
                  </p>
                ) : null}
              </div>
              {canManage ? (
                <button
                  type="button"
                  className="text-xs font-medium text-slate-500 hover:text-red-700"
                  onClick={() => {
                    if (window.confirm(m.crm.tasks.deleteConfirm)) {
                      void run(() =>
                        apiRequest(`/app/orgs/${organizationId}/crm/tasks/${task.id}`, {
                          method: 'DELETE',
                        }),
                      );
                    }
                  }}
                >
                  {m.crm.delete}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "New task" dialog; `link` pre-attaches the task to a record. */
export function NewTaskButton({
  assignees,
  link,
}: {
  assignees: Assignee[];
  link?: { contactId?: string; companyId?: string; dealId?: string };
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('crm.task.manage');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    description: '',
    dueAt: '',
    priority: 'normal',
    assigneeUserId: '',
  });
  const { run, pending, error, reset } = useMutation();
  if (!canManage) return null;

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/crm/tasks`, {
        body: {
          title: form.title,
          description: form.description,
          dueAt: fromDateTimeLocal(form.dueAt),
          priority: form.priority,
          ...(form.assigneeUserId ? { assigneeUserId: form.assigneeUserId } : {}),
          ...link,
        },
      }),
    );
    if (ok) {
      setOpen(false);
      setForm({ title: '', description: '', dueAt: '', priority: 'normal', assigneeUserId: '' });
    }
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {m.crm.tasks.new}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={m.crm.tasks.new}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <TextField
            label={m.crm.tasks.taskTitle}
            value={form.title}
            onChange={set('title')}
            error={error?.fieldError('title')}
            autoFocus
            required
          />
          <TextAreaField
            label={m.crm.tasks.description}
            rows={3}
            value={form.description}
            onChange={set('description')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={m.crm.tasks.due}
              type="datetime-local"
              value={form.dueAt}
              onChange={set('dueAt')}
              error={error?.fieldError('dueAt')}
            />
            <SelectField
              label={m.crm.tasks.priority}
              value={form.priority}
              onChange={set('priority')}
            >
              <option value="low">{m.crm.tasks.low}</option>
              <option value="normal">{m.crm.tasks.normal}</option>
              <option value="high">{m.crm.tasks.high}</option>
            </SelectField>
            <SelectField
              label={m.crm.tasks.assignee}
              value={form.assigneeUserId}
              onChange={set('assigneeUserId')}
              error={error?.fieldError('assigneeUserId')}
            >
              <option value="">{m.crm.mine}</option>
              {assignees.map((assignee) => (
                <option key={assignee.userId} value={assignee.userId}>
                  {assignee.name}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.crm.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
