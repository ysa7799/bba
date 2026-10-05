'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import { CURRENCIES, type DealSummary, type PipelineDetail } from '@/lib/crm-types';
import type { ContactFormOptions } from './contact-form';
import { changedCustomFields } from './custom-field-diff';
import { CustomFieldInputs } from './custom-field-inputs';
import { RecordPicker, type PickedRecord } from './record-picker';
import { TagPicker } from './tag-picker';

export function DealFormDialog({
  deal,
  pipelines,
  defaultPipelineId,
  defaultCurrency,
  options,
  buttonLabel,
  buttonVariant = 'primary',
  initialContact,
  initialCompany,
}: {
  deal?: DealSummary;
  pipelines: PipelineDetail[];
  defaultPipelineId?: string;
  defaultCurrency: string;
  options: ContactFormOptions;
  buttonLabel: string;
  buttonVariant?: 'primary' | 'secondary';
  initialContact?: PickedRecord;
  initialCompany?: PickedRecord;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const firstPipeline =
    pipelines.find((p) => p.id === (deal?.pipelineId ?? defaultPipelineId)) ?? pipelines[0];
  const [pipelineId, setPipelineId] = useState(firstPipeline?.id ?? '');
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const [form, setForm] = useState({
    name: deal?.name ?? '',
    stageId: deal?.stageId ?? firstPipeline?.stages.find((s) => s.kind === 'open')?.id ?? '',
    amount: deal?.value?.amount ?? '',
    currency: deal?.value?.currency ?? deal?.currency ?? defaultCurrency,
    probability:
      deal?.probabilityOverride === null || deal === undefined
        ? ''
        : String(deal.probabilityOverride),
    expectedCloseDate: deal?.expectedCloseDate ?? '',
    lostReason: deal?.lostReason ?? '',
    ownerUserId: deal ? (deal.ownerUserId ?? '') : null,
  });
  const [contact, setContact] = useState<PickedRecord | null>(
    deal?.contact ?? initialContact ?? null,
  );
  const [company, setCompany] = useState<PickedRecord | null>(
    deal?.company ?? initialCompany ?? null,
  );
  const [tagIds, setTagIds] = useState<string[]>(deal?.tags.map((tag) => tag.id) ?? []);
  const initialCustom = deal?.customFields ?? {};
  const [custom, setCustom] = useState<Record<string, unknown>>(initialCustom);
  const { run, pending, error, reset } = useMutation();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const stage = pipeline?.stages.find((s) => s.id === form.stageId);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = form.amount.trim();
    const body = {
      name: form.name,
      pipelineId,
      stageId: form.stageId,
      // Only send links that changed: a linked record hidden from this user (no read access)
      // arrives as null and must not be cleared by saving the form.
      ...((contact?.id ?? null) !== (deal?.contact?.id ?? null) || !deal
        ? { contactId: contact?.id ?? null }
        : {}),
      ...((company?.id ?? null) !== (deal?.company?.id ?? null) || !deal
        ? { companyId: company?.id ?? null }
        : {}),
      ...(amount === ''
        ? { value: null, currency: form.currency }
        : { value: { amount, currency: form.currency } }),
      probability: form.probability.trim() === '' ? null : Number.parseInt(form.probability, 10),
      expectedCloseDate: form.expectedCloseDate || null,
      ...(stage?.kind === 'lost' ? { lostReason: form.lostReason } : {}),
      ...(form.ownerUserId === null ? {} : { ownerUserId: form.ownerUserId || null }),
      tagIds,
      customFields: changedCustomFields(initialCustom, custom),
    };
    const ok = await run(async () => {
      if (deal) {
        await apiRequest(`/app/orgs/${organizationId}/crm/deals/${deal.id}`, {
          method: 'PATCH',
          body,
        });
      } else {
        await apiRequest(`/app/orgs/${organizationId}/crm/deals`, { body });
      }
    });
    if (ok) setOpen(false);
  }

  return (
    <>
      <Button
        variant={buttonVariant}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {buttonLabel}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={deal ? m.crm.edit : m.crm.deals.new}
      >
        <form
          onSubmit={onSubmit}
          className="max-h-[70vh] space-y-4 overflow-y-auto pe-1"
          noValidate
        >
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <TextField
            label={m.crm.deals.name}
            value={form.name}
            onChange={set('name')}
            error={error?.fieldError('name')}
            required
            autoFocus
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={m.crm.deals.pipeline}
              value={pipelineId}
              onChange={(event) => {
                const next = pipelines.find((p) => p.id === event.target.value);
                setPipelineId(event.target.value);
                setForm((current) => ({
                  ...current,
                  stageId: next?.stages.find((s) => s.kind === 'open')?.id ?? '',
                }));
              }}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={m.crm.deals.stage}
              value={form.stageId}
              onChange={set('stageId')}
              error={error?.fieldError('stageId')}
            >
              {(pipeline?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={m.crm.deals.amount}
              inputMode="decimal"
              value={form.amount}
              onChange={set('amount')}
              error={error?.fieldError('value.amount') ?? error?.fieldError('value')}
            />
            <SelectField
              label={m.crm.deals.currency}
              value={form.currency}
              onChange={set('currency')}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </SelectField>
            <TextField
              label={m.crm.deals.probability}
              inputMode="numeric"
              value={form.probability}
              onChange={set('probability')}
              hint={m.crm.deals.probabilityHint}
              error={error?.fieldError('probability')}
            />
            <TextField
              label={m.crm.deals.expectedClose}
              type="date"
              value={form.expectedCloseDate}
              onChange={set('expectedCloseDate')}
              error={error?.fieldError('expectedCloseDate')}
            />
            <RecordPicker
              label={m.crm.deals.contact}
              type="contact"
              value={contact}
              onChange={setContact}
              error={error?.fieldError('contactId')}
            />
            <RecordPicker
              label={m.crm.deals.company}
              type="company"
              value={company}
              onChange={setCompany}
              error={error?.fieldError('companyId')}
            />
            {form.ownerUserId !== null ? (
              <SelectField
                label={m.crm.owner}
                value={form.ownerUserId}
                onChange={set('ownerUserId')}
              >
                <option value="">{m.crm.noOwner}</option>
                {options.assignees.map((assignee) => (
                  <option key={assignee.userId} value={assignee.userId}>
                    {assignee.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            {stage?.kind === 'lost' ? (
              <TextField
                label={m.crm.deals.lostReason}
                value={form.lostReason}
                onChange={set('lostReason')}
              />
            ) : null}
          </div>
          <TagPicker tags={options.tags} value={tagIds} onChange={setTagIds} />
          <CustomFieldInputs
            fields={options.fields}
            values={custom}
            onChange={(key, value) => setCustom((current) => ({ ...current, [key]: value }))}
            errorFor={(path) => error?.fieldError(path)}
            assignees={options.assignees}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {deal ? m.crm.save : m.crm.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
