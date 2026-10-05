'use client';

import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { Section } from '@/components/crm/detail';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import {
  ACTION_TYPES,
  type ActionType,
  type AutomationOptions,
  type Definition,
  type NodeType,
  type VersionView,
  type WorkflowDetail,
} from '@/lib/automation-types';
import { cn } from '@/lib/cn';
import { StepConfig } from './step-config';
import { TriggerConfig } from './trigger-config';
import { defaultConfig, flatten, mapTree, nextKey, toDefinition, toTree, type Step } from './tree';

type Notice = 'saved' | 'published' | null;
type Kind = NodeType | ActionType;

/** Edits the draft (or the live version when there is none); the API validates it again. */
export function WorkflowBuilder({
  workflow,
  source,
  options,
}: {
  workflow: WorkflowDetail;
  source: VersionView;
  options: AutomationOptions;
}) {
  const m = useMessages();
  const a = m.automation;
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [uidCounter, setUidCounter] = useState(1_000);
  const [trigger, setTrigger] = useState<Definition['trigger']>(source.definition.trigger);
  const [steps, setSteps] = useState<Step[]>(() => {
    let n = 0;
    return toTree(source.definition, () => `initial-${(n += 1)}`);
  });
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [discarding, setDiscarding] = useState(false);
  const base = `/app/orgs/${organizationId}/automation/workflows/${workflow.id}`;
  const errorFor = (path: string) => error?.fieldError(path);
  const indexes = new Map(flatten(steps).map((step, index) => [step.uid, index]));

  function change(next: Step[]) {
    setSteps(next);
    setDirty(true);
    setNotice(null);
  }

  function create(kind: Kind): Step {
    const type: NodeType = kind === 'wait' || kind === 'condition' ? kind : 'action';
    const action = type === 'action' ? (kind as ActionType) : null;
    setUidCounter((n) => n + 1);
    return {
      uid: `new-${uidCounter}`,
      key: nextKey(steps),
      type,
      action,
      label: null,
      config: defaultConfig(type, action),
      yes: [],
      no: [],
    };
  }

  async function save(): Promise<boolean> {
    const ok = await run(() =>
      apiRequest(`${base}/draft`, { method: 'PUT', body: toDefinition(trigger, steps) }),
    );
    if (ok) {
      setDirty(false);
      setNotice('saved');
    }
    return ok;
  }

  async function publish() {
    if (dirty && !(await save())) return;
    const ok = await run(() => apiRequest(`${base}/publish`, { method: 'POST' }));
    if (ok) setNotice('published');
  }

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/95 px-4 py-3 sm:-mx-6 sm:px-6">
        <p className="text-sm text-slate-600" role="status">
          {dirty
            ? a.unsaved
            : notice === 'saved'
              ? a.saved
              : notice === 'published'
                ? a.published
                : a.publishHint}
        </p>
        <div className="flex flex-wrap gap-2">
          {workflow.hasDraft && workflow.published && !dirty ? (
            <Button variant="ghost" onClick={() => setDiscarding(true)}>
              {a.discard}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => void save()}
            loading={pending}
            disabled={!dirty}
          >
            {a.saveDraft}
          </Button>
          <Button
            onClick={() => void publish()}
            loading={pending}
            disabled={!dirty && !workflow.hasDraft}
          >
            {a.publish}
          </Button>
        </div>
      </div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <Section title={a.trigger}>
        <TriggerConfig
          trigger={trigger}
          options={options}
          error={errorFor}
          onChange={(next) => {
            setTrigger(next);
            setDirty(true);
            setNotice(null);
          }}
        />
      </Section>
      <Section title={a.steps}>
        <p className="mb-3 text-xs text-slate-500">{a.placeholdersHint}</p>
        <StepList
          steps={steps}
          options={options}
          indexes={indexes}
          error={errorFor}
          create={create}
          onChange={(list) => change(list)}
          onUpdate={(uid, update) => change(mapTree(steps, uid, update))}
        />
        {errorFor('nodes') ? (
          <p className="mt-2 text-sm text-red-600">{errorFor('nodes')}</p>
        ) : null}
      </Section>
      <ConfirmDialog
        open={discarding}
        title={a.discard}
        message={a.discardConfirm}
        confirmLabel={a.discard}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onConfirm={() =>
          void run(async () => {
            const result = await apiRequest<{ workflow: WorkflowDetail }>(`${base}/draft`, {
              method: 'DELETE',
            });
            const live = result.workflow.published;
            if (live) {
              setTrigger(live.definition.trigger);
              let n = 0;
              setSteps(toTree(live.definition, () => `live-${(n += 1)}`));
            }
          }).then((ok) => {
            if (ok) {
              setDiscarding(false);
              setDirty(false);
              reset();
            }
          })
        }
        onClose={() => setDiscarding(false)}
      />
    </div>
  );
}

function StepList({
  steps,
  options,
  indexes,
  error,
  create,
  onChange,
  onUpdate,
  nested = false,
}: {
  steps: Step[];
  options: AutomationOptions;
  indexes: Map<string, number>;
  error: (path: string) => string | undefined;
  create: (kind: Kind) => Step;
  onChange: (steps: Step[]) => void;
  onUpdate: (uid: string, update: (step: Step) => Step | null) => void;
  nested?: boolean;
}) {
  const m = useMessages();
  const a = m.automation;
  const [kind, setKind] = useState<Kind>('task.create');
  const endsWithCondition = steps.at(-1)?.type === 'condition';

  function move(index: number, delta: -1 | 1) {
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(index + delta, 0, moved);
    // A condition must stay last in its list.
    if (next.slice(0, -1).some((step) => step.type === 'condition')) return;
    onChange(next);
  }

  return (
    <div className={cn('space-y-3', nested && 'border-s-2 border-slate-200 ps-4')}>
      {steps.length === 0 && !nested ? <p className="text-sm text-slate-500">{a.noSteps}</p> : null}
      <ol className="space-y-3">
        {steps.map((step, index) => {
          const position = indexes.get(step.uid) ?? 0;
          const configError = (key: string) => error(`nodes.${position}.config.${key}`);
          const title =
            step.type === 'action' && step.action ? a.actions[step.action] : a.stepKinds[step.type];
          return (
            <li
              key={step.uid}
              className="rounded-lg border border-slate-200 bg-white p-4"
              data-step-key={step.key}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  {index + 1}. {title}
                </p>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`${a.moveUp}: ${title}`}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`${a.moveDown}: ${title}`}
                  >
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onUpdate(step.uid, () => null)}>
                    {a.remove}
                  </Button>
                </div>
              </div>
              {error(`nodes.${position}`) ? (
                <p className="mb-2 text-sm text-red-600">{error(`nodes.${position}`)}</p>
              ) : null}
              <div className="space-y-3">
                <TextField
                  label={a.stepLabel}
                  value={step.label ?? ''}
                  maxLength={120}
                  onChange={(event) =>
                    onUpdate(step.uid, (current) => ({ ...current, label: event.target.value }))
                  }
                />
                <StepConfig
                  step={step}
                  options={options}
                  error={configError}
                  onChange={(config) => onUpdate(step.uid, (current) => ({ ...current, config }))}
                />
              </div>
              {step.type === 'condition' ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  {(['yes', 'no'] as const).map((branch) => (
                    <div key={branch} data-branch={branch}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {branch === 'yes' ? a.yes : a.no}
                      </p>
                      <StepList
                        steps={step[branch]}
                        options={options}
                        indexes={indexes}
                        error={error}
                        create={create}
                        nested
                        onChange={(list) =>
                          onUpdate(step.uid, (current) => ({ ...current, [branch]: list }))
                        }
                        onUpdate={onUpdate}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {endsWithCondition ? null : (
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label={a.addStep}
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
            className="w-64"
          >
            <optgroup label={a.stepKinds.action}>
              {ACTION_TYPES.map((action) => (
                <option key={action} value={action}>
                  {a.actions[action]}
                </option>
              ))}
            </optgroup>
            <option value="wait">{a.stepKinds.wait}</option>
            <option value="condition">{a.stepKinds.condition}</option>
          </SelectField>
          <Button
            variant="secondary"
            onClick={() => onChange([...steps, create(kind)])}
            disabled={flattenCount(steps) >= 50}
          >
            {a.addStep}
          </Button>
        </div>
      )}
    </div>
  );
}

function flattenCount(steps: Step[]): number {
  return flatten(steps).length;
}
