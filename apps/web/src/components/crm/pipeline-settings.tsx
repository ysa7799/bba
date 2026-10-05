'use client';

import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { PipelineDetail, StageKind } from '@/lib/crm-types';

function StageRow({
  pipeline,
  index,
  canManage,
  run,
}: {
  pipeline: PipelineDetail;
  index: number;
  canManage: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const stage = pipeline.stages[index];
  const [name, setName] = useState(stage?.name ?? '');
  const [probability, setProbability] = useState(String(stage?.probability ?? 0));
  if (!stage) return null;
  const base = `/app/orgs/${organizationId}/crm/pipelines/${pipeline.id}/stages`;
  const reorder = (offset: number) => {
    const ids = pipeline.stages.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + offset, 0, moved);
    void run(() => apiRequest(`${base}/order`, { method: 'PUT', body: { stageIds: ids } }));
  };
  const dirty = name !== stage.name || probability !== String(stage.probability);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <input
        aria-label={m.crm.settings.stageName}
        className={`${inputClass} w-48`}
        value={name}
        disabled={!canManage}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        aria-label={m.crm.deals.probability}
        className={`${inputClass} w-20`}
        inputMode="numeric"
        value={probability}
        disabled={!canManage}
        onChange={(event) => setProbability(event.target.value)}
      />
      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
        {m.crm.settings.kinds[stage.kind]}
      </span>
      {canManage ? (
        <span className="flex flex-wrap gap-1">
          {dirty ? (
            <Button
              size="sm"
              onClick={() =>
                void run(() =>
                  apiRequest(`${base}/${stage.id}`, {
                    method: 'PATCH',
                    body: { name, probability: Number.parseInt(probability, 10) },
                  }),
                )
              }
            >
              {m.crm.save}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={index === 0}
            onClick={() => reorder(-1)}
            aria-label={`${m.crm.settings.moveUp}: ${stage.name}`}
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={index === pipeline.stages.length - 1}
            onClick={() => reorder(1)}
            aria-label={`${m.crm.settings.moveDown}: ${stage.name}`}
          >
            ↓
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(format(m.crm.settings.deleteStageConfirm, { name: stage.name }))) {
                void run(() => apiRequest(`${base}/${stage.id}`, { method: 'DELETE' }));
              }
            }}
          >
            {m.crm.delete}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

export function PipelineSettings({ pipelines }: { pipelines: PipelineDetail[] }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('crm.pipeline.manage');
  const { run, pending, error } = useMutation();
  const [newPipeline, setNewPipeline] = useState('');
  const [newStage, setNewStage] = useState<Record<string, { name: string; kind: StageKind }>>({});
  const base = `/app/orgs/${organizationId}/crm/pipelines`;

  return (
    <Card className="space-y-4 p-4">
      <h2 className="text-sm font-semibold text-slate-900">{m.crm.settings.pipelines}</h2>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {pipelines.map((pipeline) => {
        const draft = newStage[pipeline.id] ?? { name: '', kind: 'open' as StageKind };
        return (
          <div key={pipeline.id} className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium text-slate-900">
                {pipeline.name}
                {pipeline.isDefault ? (
                  <span className="ms-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
                    {m.crm.settings.default}
                  </span>
                ) : null}
              </h3>
              {canManage && !pipeline.isDefault ? (
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(() =>
                        apiRequest(`${base}/${pipeline.id}`, {
                          method: 'PATCH',
                          body: { isDefault: true },
                        }),
                      )
                    }
                  >
                    {m.crm.settings.makeDefault}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (
                        window.confirm(
                          format(m.crm.settings.archiveConfirm, { name: pipeline.name }),
                        )
                      ) {
                        void run(() => apiRequest(`${base}/${pipeline.id}`, { method: 'DELETE' }));
                      }
                    }}
                  >
                    {m.crm.settings.archive}
                  </Button>
                </span>
              ) : null}
            </div>
            <ol className="divide-y divide-slate-100">
              {pipeline.stages.map((stage, index) => (
                <StageRow
                  key={`${stage.id}-${stage.name}-${String(stage.probability)}`}
                  pipeline={pipeline}
                  index={index}
                  canManage={canManage}
                  run={run}
                />
              ))}
            </ol>
            {canManage ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  aria-label={m.crm.settings.stageName}
                  placeholder={m.crm.settings.stageName}
                  className={`${inputClass} w-48`}
                  value={draft.name}
                  onChange={(event) =>
                    setNewStage((current) => ({
                      ...current,
                      [pipeline.id]: { ...draft, name: event.target.value },
                    }))
                  }
                />
                <select
                  aria-label={m.crm.settings.stageKind}
                  className={`${inputClass} w-28`}
                  value={draft.kind}
                  onChange={(event) =>
                    setNewStage((current) => ({
                      ...current,
                      [pipeline.id]: { ...draft, kind: event.target.value as StageKind },
                    }))
                  }
                >
                  {(['open', 'won', 'lost'] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {m.crm.settings.kinds[kind]}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={pending}
                  disabled={!draft.name.trim()}
                  onClick={() =>
                    void run(() =>
                      apiRequest(`${base}/${pipeline.id}/stages`, { body: draft }),
                    ).then((ok) => {
                      if (ok)
                        setNewStage((current) => ({
                          ...current,
                          [pipeline.id]: { name: '', kind: 'open' },
                        }));
                    })
                  }
                >
                  {m.crm.settings.addStage}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={m.crm.settings.pipelineName}
            placeholder={m.crm.settings.pipelineName}
            className={`${inputClass} w-64`}
            value={newPipeline}
            onChange={(event) => setNewPipeline(event.target.value)}
          />
          <Button
            variant="secondary"
            loading={pending}
            disabled={!newPipeline.trim()}
            onClick={() =>
              void run(() => apiRequest(base, { body: { name: newPipeline } })).then((ok) => {
                if (ok) setNewPipeline('');
              })
            }
          >
            {m.crm.settings.newPipeline}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
