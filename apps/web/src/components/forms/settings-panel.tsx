'use client';

import { useMessages } from '@/components/i18n-provider';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { humanize } from '@/lib/format';
import { LIFECYCLE_STAGES, type BuilderOptions, type FormSettings } from '@/lib/forms-types';

export function SettingsPanel({
  settings,
  options,
  errors,
  onChange,
}: {
  settings: FormSettings;
  options: BuilderOptions;
  errors: (path: string) => string | undefined;
  onChange: (settings: FormSettings) => void;
}) {
  const m = useMessages();
  const set = (patch: Partial<FormSettings>) => onChange({ ...settings, ...patch });
  const setContact = (patch: Partial<FormSettings['contact']>) =>
    set({ contact: { ...settings.contact, ...patch } });
  const pipeline = options.pipelines.find((entry) => entry.id === settings.deal?.pipelineId);
  const captchaConfigured = options.captcha.status === 'CONFIGURED';
  const nullable = (value: string) => (value.trim() === '' ? null : value);

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <TextField
          label={m.forms.publicTitle}
          hint={m.forms.publicTitleHint}
          value={settings.title ?? ''}
          onChange={(event) => set({ title: nullable(event.target.value) })}
          maxLength={120}
          error={errors('settings.title')}
        />
        <TextAreaField
          label={m.forms.description}
          rows={3}
          value={settings.description ?? ''}
          onChange={(event) => set({ description: nullable(event.target.value) })}
          maxLength={2_000}
        />
        <TextField
          label={m.forms.submitLabel}
          value={settings.submitLabel}
          onChange={(event) => set({ submitLabel: event.target.value })}
          maxLength={40}
          required
          error={errors('settings.submitLabel')}
        />
        <TextAreaField
          label={m.forms.successMessage}
          rows={2}
          value={settings.successMessage}
          onChange={(event) => set({ successMessage: event.target.value })}
          maxLength={1_000}
          required
          error={errors('settings.successMessage')}
        />
        <TextField
          label={m.forms.redirectUrl}
          type="url"
          placeholder="https://"
          value={settings.redirectUrl ?? ''}
          onChange={(event) => set({ redirectUrl: nullable(event.target.value) })}
          maxLength={500}
          error={errors('settings.redirectUrl')}
        />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-900">{m.forms.crm}</legend>
        <CheckboxField
          label={m.forms.createContact}
          checked={settings.contact.enabled}
          onChange={(event) =>
            set({
              contact: { ...settings.contact, enabled: event.target.checked },
              ...(event.target.checked ? {} : { deal: null }),
            })
          }
        />
        <p className="text-xs text-slate-500">{m.forms.createContactHint}</p>
        {settings.contact.enabled ? (
          <>
            <SelectField
              label={m.forms.owner}
              value={settings.contact.ownerUserId ?? ''}
              onChange={(event) => setContact({ ownerUserId: nullable(event.target.value) })}
              error={errors('settings.contact.ownerUserId')}
            >
              <option value="">{m.forms.noOwner}</option>
              {options.members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={m.forms.lifecycleStage}
              value={settings.contact.lifecycleStage ?? ''}
              onChange={(event) =>
                setContact({
                  lifecycleStage:
                    (nullable(event.target.value) as FormSettings['contact']['lifecycleStage']) ??
                    null,
                })
              }
            >
              <option value="">{m.forms.keepDefault}</option>
              {LIFECYCLE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {humanize(stage)}
                </option>
              ))}
            </SelectField>
            {options.tags.length > 0 ? (
              <div>
                <p className="mb-1.5 text-sm font-medium text-slate-800">{m.forms.tags}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {options.tags.map((tag) => (
                    <CheckboxField
                      key={tag.id}
                      label={tag.name}
                      checked={settings.contact.tagIds.includes(tag.id)}
                      onChange={(event) =>
                        setContact({
                          tagIds: event.target.checked
                            ? [...settings.contact.tagIds, tag.id]
                            : settings.contact.tagIds.filter((id) => id !== tag.id),
                        })
                      }
                    />
                  ))}
                </div>
                {errors('settings.contact.tagIds') ? (
                  <p className="mt-1 text-sm text-red-600">{errors('settings.contact.tagIds')}</p>
                ) : null}
              </div>
            ) : null}
            <CheckboxField
              label={m.forms.addNote}
              checked={settings.contact.addNote}
              onChange={(event) => setContact({ addNote: event.target.checked })}
            />
            <CheckboxField
              label={m.forms.createDeal}
              checked={settings.deal !== null}
              disabled={options.pipelines.length === 0}
              onChange={(event) =>
                set({
                  deal:
                    event.target.checked && options.pipelines[0]
                      ? { pipelineId: options.pipelines[0].id, stageId: null }
                      : null,
                })
              }
            />
            {settings.deal ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label={m.forms.pipeline}
                  value={settings.deal.pipelineId}
                  onChange={(event) =>
                    set({ deal: { pipelineId: event.target.value, stageId: null } })
                  }
                  error={errors('settings.deal')}
                >
                  {options.pipelines.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={m.forms.stage}
                  value={settings.deal.stageId ?? ''}
                  onChange={(event) =>
                    set({
                      deal: {
                        pipelineId: settings.deal?.pipelineId ?? '',
                        stageId: nullable(event.target.value),
                      },
                    })
                  }
                  error={errors('settings.deal.stageId')}
                >
                  <option value="">{m.forms.firstStage}</option>
                  {pipeline?.stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </SelectField>
              </div>
            ) : null}
          </>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-900">{m.forms.protection}</legend>
        <p className="text-xs text-slate-500">{m.forms.protectionHint}</p>
        <CheckboxField
          label={m.forms.captcha}
          checked={settings.captcha}
          disabled={!captchaConfigured && !settings.captcha}
          onChange={(event) => set({ captcha: event.target.checked })}
        />
        {!captchaConfigured ? (
          <p className="text-xs text-slate-500">{m.forms.captchaUnavailable}</p>
        ) : null}
        {errors('settings.captcha') ? (
          <p className="text-sm text-red-600">{errors('settings.captcha')}</p>
        ) : null}
        <TextAreaField
          label={m.forms.embedOrigins}
          hint={m.forms.embedOriginsHint}
          rows={3}
          value={settings.embedOrigins.join('\n')}
          onChange={(event) =>
            set({
              embedOrigins: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line, index, all) => line !== '' || index === all.length - 1),
            })
          }
          error={
            errors('settings.embedOrigins') ??
            settings.embedOrigins
              .map((_, index) => errors(`settings.embedOrigins.${index}`))
              .find(Boolean)
          }
        />
      </fieldset>
    </div>
  );
}
