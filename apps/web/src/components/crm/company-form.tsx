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
import type { CompanySummary } from '@/lib/crm-types';
import type { ContactFormOptions } from './contact-form';
import { changedCustomFields } from './custom-field-diff';
import { CustomFieldInputs } from './custom-field-inputs';
import { TagPicker } from './tag-picker';

export function CompanyFormDialog({
  company,
  options,
  buttonLabel,
  buttonVariant = 'primary',
}: {
  company?: CompanySummary;
  options: ContactFormOptions;
  buttonLabel: string;
  buttonVariant?: 'primary' | 'secondary';
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const initialCustom = company?.customFields ?? {};
  const [form, setForm] = useState({
    name: company?.name ?? '',
    domain: company?.domain ?? '',
    website: company?.website ?? '',
    phone: company?.phone ?? '',
    industry: company?.industry ?? '',
    employeeCount:
      company?.employeeCount === null || company === undefined ? '' : String(company.employeeCount),
    city: company?.city ?? '',
    countryCode: company?.countryCode ?? '',
    ownerUserId: company ? (company.ownerUserId ?? '') : null,
  });
  const [tagIds, setTagIds] = useState<string[]>(company?.tags.map((tag) => tag.id) ?? []);
  const [custom, setCustom] = useState<Record<string, unknown>>(initialCustom);
  const { run, pending, error, reset } = useMutation();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const employees = form.employeeCount.trim();
    const body = {
      name: form.name,
      domain: form.domain,
      website: form.website,
      phone: form.phone,
      industry: form.industry,
      employeeCount: employees === '' ? null : Number.parseInt(employees, 10),
      city: form.city,
      countryCode: form.countryCode.trim() === '' ? null : form.countryCode,
      tagIds,
      ...(form.ownerUserId === null ? {} : { ownerUserId: form.ownerUserId || null }),
      customFields: changedCustomFields(initialCustom, custom),
    };
    const created: { id: string | null } = { id: null };
    const ok = await run(
      async () => {
        if (company) {
          await apiRequest(`/app/orgs/${organizationId}/crm/companies/${company.id}`, {
            method: 'PATCH',
            body,
          });
        } else {
          const response = await apiRequest<{ company: { id: string } }>(
            `/app/orgs/${organizationId}/crm/companies`,
            {
              body,
            },
          );
          created.id = response.company.id;
        }
      },
      { refresh: company !== undefined },
    );
    if (ok) {
      setOpen(false);
      if (created.id) router.push(`/o/${organizationId}/crm/companies/${created.id}`);
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
        title={company ? m.crm.edit : m.crm.companies.new}
      >
        <form
          onSubmit={onSubmit}
          className="max-h-[70vh] space-y-4 overflow-y-auto pe-1"
          noValidate
        >
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={m.crm.companies.name}
              value={form.name}
              onChange={set('name')}
              error={error?.fieldError('name')}
              required
              autoFocus
            />
            <TextField
              label={m.crm.companies.domain}
              value={form.domain}
              onChange={set('domain')}
              error={error?.fieldError('domain')}
            />
            <TextField
              label={m.crm.companies.website}
              value={form.website}
              onChange={set('website')}
              error={error?.fieldError('website')}
            />
            <TextField
              label={m.crm.companies.phone}
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              error={error?.fieldError('phone')}
            />
            <TextField
              label={m.crm.companies.industry}
              value={form.industry}
              onChange={set('industry')}
            />
            <TextField
              label={m.crm.companies.employees}
              inputMode="numeric"
              value={form.employeeCount}
              onChange={set('employeeCount')}
              error={error?.fieldError('employeeCount')}
            />
            <TextField label={m.crm.companies.city} value={form.city} onChange={set('city')} />
            <TextField
              label={m.crm.companies.country}
              maxLength={2}
              value={form.countryCode}
              onChange={set('countryCode')}
              error={error?.fieldError('countryCode')}
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
              {company ? m.crm.save : m.crm.create}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
