'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import {
  LIFECYCLE_STAGES,
  type Assignee,
  type ContactDetail,
  type CustomFieldDefinition,
  type TagSummary,
} from '@/lib/crm-types';
import { changedCustomFields } from './custom-field-diff';
import { CustomFieldInputs } from './custom-field-inputs';
import { RecordPicker, type PickedRecord } from './record-picker';
import { TagPicker } from './tag-picker';

export interface ContactFormOptions {
  tags: TagSummary[];
  fields: CustomFieldDefinition[];
  assignees: Assignee[];
}

/** Create (no `contact`) or edit a contact in a dialog. */
export function ContactFormDialog({
  contact,
  options,
  buttonLabel,
  buttonVariant = 'primary',
}: {
  contact?: ContactDetail;
  options: ContactFormOptions;
  buttonLabel: string;
  buttonVariant?: 'primary' | 'secondary';
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const initialCustom = contact?.customFields ?? {};
  const [form, setForm] = useState({
    firstName: contact?.firstName ?? '',
    lastName: contact?.lastName ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    whatsappPhone: contact?.whatsappPhone ?? '',
    jobTitle: contact?.jobTitle ?? '',
    lifecycleStage: contact?.lifecycleStage ?? 'lead',
    status: contact?.status ?? 'active',
    ownerUserId: contact ? (contact.ownerUserId ?? '') : null,
  });
  const [tagIds, setTagIds] = useState<string[]>(contact?.tags.map((tag) => tag.id) ?? []);
  const [company, setCompany] = useState<PickedRecord | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>(initialCustom);
  const { run, pending, error, reset } = useMutation();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email,
      phone: form.phone,
      whatsappPhone: form.whatsappPhone,
      jobTitle: form.jobTitle,
      lifecycleStage: form.lifecycleStage,
      status: form.status,
      tagIds,
      ...(form.ownerUserId === null ? {} : { ownerUserId: form.ownerUserId || null }),
      customFields: changedCustomFields(initialCustom, custom),
      ...(contact ? {} : company ? { companyId: company.id } : {}),
    };
    const created: { id: string | null } = { id: null };
    const ok = await run(
      async () => {
        if (contact) {
          await apiRequest(`/app/orgs/${organizationId}/crm/contacts/${contact.id}`, {
            method: 'PATCH',
            body,
          });
        } else {
          const response = await apiRequest<{ contact: { id: string } }>(
            `/app/orgs/${organizationId}/crm/contacts`,
            {
              body,
            },
          );
          created.id = response.contact.id;
        }
      },
      { refresh: contact !== undefined },
    );
    if (ok) {
      setOpen(false);
      if (created.id) router.push(`/o/${organizationId}/crm/contacts/${created.id}`);
    }
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
        title={contact ? m.crm.edit : m.crm.contacts.new}
      >
        <form
          onSubmit={onSubmit}
          className="max-h-[70vh] space-y-4 overflow-y-auto pe-1"
          noValidate
        >
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          {error?.code === 'validation_error' && error.details.length === 0 ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={m.crm.contacts.firstName}
              value={form.firstName}
              onChange={set('firstName')}
              error={error?.fieldError('firstName')}
              autoFocus
            />
            <TextField
              label={m.crm.contacts.lastName}
              value={form.lastName}
              onChange={set('lastName')}
            />
            <TextField
              label={m.crm.contacts.email}
              type="email"
              value={form.email}
              onChange={set('email')}
              error={error?.fieldError('email')}
            />
            <TextField
              label={m.crm.contacts.phone}
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              hint={m.crm.contacts.phoneHint}
              error={error?.fieldError('phone')}
            />
            <TextField
              label={m.crm.contacts.whatsapp}
              type="tel"
              value={form.whatsappPhone}
              onChange={set('whatsappPhone')}
              error={error?.fieldError('whatsappPhone')}
            />
            <TextField
              label={m.crm.contacts.jobTitle}
              value={form.jobTitle}
              onChange={set('jobTitle')}
            />
            <SelectField
              label={m.crm.lifecycle.label}
              value={form.lifecycleStage}
              onChange={set('lifecycleStage')}
            >
              {LIFECYCLE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {m.crm.lifecycle[stage]}
                </option>
              ))}
            </SelectField>
            <SelectField label={m.crm.contacts.status} value={form.status} onChange={set('status')}>
              <option value="active">{m.crm.contacts.active}</option>
              <option value="inactive">{m.crm.contacts.inactive}</option>
            </SelectField>
            {form.ownerUserId !== null ? (
              <SelectField
                label={m.crm.owner}
                value={form.ownerUserId}
                onChange={set('ownerUserId')}
                error={error?.fieldError('ownerUserId')}
              >
                <option value="">{m.crm.noOwner}</option>
                {options.assignees.map((assignee) => (
                  <option key={assignee.userId} value={assignee.userId}>
                    {assignee.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            {!contact ? (
              <RecordPicker
                label={m.crm.contacts.company}
                type="company"
                value={company}
                onChange={setCompany}
                error={error?.fieldError('companyId')}
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
              {contact ? m.crm.save : m.crm.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
