'use client';

import Link from 'next/link';
import { useState, type DragEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { format } from '@/i18n';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { BoardStage, DealBoard, DealSummary } from '@/lib/crm-types';
import { formatDate, formatMoney } from '@/lib/format';

interface PendingMove {
  deal: DealSummary;
  stageId: string;
  afterDealId: string | null;
  beforeDealId: string | null;
}

const KIND_STYLES: Record<string, string> = {
  open: 'border-t-slate-300',
  won: 'border-t-emerald-500',
  lost: 'border-t-red-400',
};

/**
 * Kanban board for a pipeline. Cards can be dragged between and within stages, or moved with
 * the per-card stage selector (keyboard and screen-reader friendly). The server decides the
 * final order and status; the board refreshes from it after every move.
 */
export function DealBoardView({ board }: { board: DealBoard }) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canMove = useCan('crm.deal.update');
  const [stages, setStages] = useState<BoardStage[]>(board.stages);
  const [dragging, setDragging] = useState<string | null>(null);
  const [lostMove, setLostMove] = useState<PendingMove | null>(null);
  const [lostReason, setLostReason] = useState('');
  const { run, pending, error } = useMutation();

  // Re-sync with fresh server data after a refresh (state derived from props, no effect).
  const [source, setSource] = useState(board);
  if (source !== board) {
    setSource(board);
    setStages(board.stages);
  }

  function locate(dealId: string): DealSummary | undefined {
    for (const stage of stages) {
      const deal = stage.deals.find((d) => d.id === dealId);
      if (deal) return deal;
    }
    return undefined;
  }

  function optimistic(move: PendingMove) {
    setStages((current) => {
      const without = current.map((stage) => ({
        ...stage,
        deals: stage.deals.filter((d) => d.id !== move.deal.id),
      }));
      return without.map((stage) => {
        if (stage.id !== move.stageId) return stage;
        const deals = [...stage.deals];
        const index = move.beforeDealId
          ? Math.max(
              0,
              deals.findIndex((d) => d.id === move.beforeDealId),
            )
          : move.afterDealId
            ? deals.findIndex((d) => d.id === move.afterDealId) + 1
            : 0;
        deals.splice(index, 0, { ...move.deal, stageId: stage.id, stageName: stage.name });
        return { ...stage, deals };
      });
    });
  }

  function submit(move: PendingMove, reason?: string) {
    optimistic(move);
    void run(() =>
      apiRequest(`/app/orgs/${organizationId}/crm/deals/${move.deal.id}/move`, {
        body: {
          stageId: move.stageId,
          afterDealId: move.afterDealId,
          beforeDealId: move.beforeDealId,
          ...(reason !== undefined ? { lostReason: reason } : {}),
        },
      }),
    ).then((ok) => {
      if (!ok) setStages(board.stages);
    });
  }

  function requestMove(move: PendingMove) {
    const target = stages.find((stage) => stage.id === move.stageId);
    if (target?.kind === 'lost' && move.deal.stageId !== move.stageId) {
      setLostReason('');
      setLostMove(move);
      return;
    }
    submit(move);
  }

  function onDrop(event: DragEvent, stage: BoardStage, beforeDeal: DealSummary | null) {
    event.preventDefault();
    event.stopPropagation();
    const dealId = event.dataTransfer.getData('text/plain') || dragging;
    setDragging(null);
    if (!dealId || dealId === beforeDeal?.id) return;
    const deal = locate(dealId);
    if (!deal) return;
    const others = stage.deals.filter((d) => d.id !== dealId);
    let afterDealId: string | null;
    let beforeDealId: string | null;
    if (beforeDeal) {
      const index = others.findIndex((d) => d.id === beforeDeal.id);
      beforeDealId = beforeDeal.id;
      afterDealId = index > 0 ? (others[index - 1]?.id ?? null) : null;
    } else {
      afterDealId = others.at(-1)?.id ?? null;
      beforeDealId = null;
    }
    requestMove({ deal, stageId: stage.id, afterDealId, beforeDealId });
  }

  return (
    <div>
      {error ? (
        <div className="mb-3">
          <Alert tone="error">{error.message}</Alert>
        </div>
      ) : null}
      <div className="flex gap-4 overflow-x-auto pb-4" aria-busy={pending || undefined}>
        {stages.map((stage) => (
          <section
            key={stage.id}
            aria-label={stage.name}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-lg border border-t-4 border-slate-200 bg-slate-50',
              KIND_STYLES[stage.kind],
            )}
            onDragOver={(event) => {
              if (canMove) event.preventDefault();
            }}
            onDrop={(event) => onDrop(event, stage, null)}
          >
            <header className="border-b border-slate-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-semibold text-slate-900">{stage.name}</h2>
                <span className="text-xs text-slate-500">
                  {format(m.crm.deals.dealsCount, { count: String(stage.count) })}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-600">
                {stage.totals.length > 0 ? stage.totals.map(formatMoney).join(' · ') : '—'}
                {stage.kind === 'open' ? ` · ${stage.probability}%` : ''}
              </p>
            </header>
            <ol className="flex min-h-24 flex-1 flex-col gap-2 p-2">
              {stage.deals.length === 0 ? (
                <li className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500">
                  {m.crm.deals.empty}
                </li>
              ) : null}
              {stage.deals.map((deal) => (
                <li
                  key={deal.id}
                  draggable={canMove}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', deal.id);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(deal.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(event) => {
                    if (canMove) event.preventDefault();
                  }}
                  onDrop={(event) => onDrop(event, stage, deal)}
                  data-testid="deal-card"
                  className={cn(
                    'rounded-md border border-slate-200 bg-white p-3 text-sm shadow-sm',
                    canMove && 'cursor-grab',
                    dragging === deal.id && 'opacity-50',
                  )}
                >
                  <Link
                    href={`/o/${organizationId}/crm/deals/${deal.id}`}
                    className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                  >
                    {deal.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {[deal.contact?.name, deal.company?.name].filter(Boolean).join(' · ') || '—'}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-800">
                      {deal.value ? formatMoney(deal.value) : '—'}
                    </span>
                    <span className="text-slate-500">
                      {deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : ''}
                    </span>
                  </div>
                  {canMove ? (
                    <label className="mt-2 block">
                      <span className="sr-only">{m.crm.deals.moveTo}</span>
                      <select
                        className="w-full rounded border-0 bg-slate-50 py-1 text-xs text-slate-700 ring-1 ring-inset ring-slate-200"
                        value={stage.id}
                        aria-label={`${m.crm.deals.moveTo}: ${deal.name}`}
                        onChange={(event) =>
                          requestMove({
                            deal,
                            stageId: event.target.value,
                            afterDealId: null,
                            beforeDealId: null,
                          })
                        }
                      >
                        {stages.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <Dialog open={lostMove !== null} onClose={() => setLostMove(null)} title={m.crm.deals.lost}>
        <div className="space-y-4">
          <TextField
            label={m.crm.deals.lostReason}
            value={lostReason}
            onChange={(event) => setLostReason(event.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLostMove(null)}>
              {m.common.cancel}
            </Button>
            <Button
              onClick={() => {
                if (lostMove) submit(lostMove, lostReason);
                setLostMove(null);
              }}
            >
              {m.common.confirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
