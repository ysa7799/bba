'use client';

import { useMessages } from '@/components/i18n-provider';
import { CheckboxField, SelectField } from '@/components/ui/field';
import { TRIGGER_TYPES, type AutomationOptions, type Definition } from '@/lib/automation-types';

const CONTACT_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'whatsappPhone',
  'jobTitle',
  'ownerUserId',
  'lifecycleStage',
  'status',
  'customFields',
  'tags',
] as const;

type Trigger = Definition['trigger'];

export function TriggerConfig({
  trigger,
  options,
  error,
  onChange,
}: {
  trigger: Trigger;
  options: AutomationOptions;
  error: (path: string) => string | undefined;
  onChange: (trigger: Trigger) => void;
}) {
  const m = useMessages();
  const a = m.automation;
  const config = trigger.config;
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...trigger, config: { ...config, ...patch } });
  const value = (key: string) => (typeof config[key] === 'string' ? config[key] : '');
  const optional = (key: string, label: string, items: { id: string; name: string }[]) => (
    <SelectField
      label={label}
      value={value(key)}
      onChange={(event) => set({ [key]: event.target.value || null })}
      error={error(`trigger.config.${key}`)}
    >
      <option value="">{a.anyValue}</option>
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </SelectField>
  );
  const pipeline = options.pipelines.find((entry) => entry.id === config.pipelineId);

  return (
    <div className="space-y-3">
      <SelectField
        label={a.trigger}
        value={trigger.type}
        onChange={(event) => onChange({ type: event.target.value as Trigger['type'], config: {} })}
        error={error('trigger.type')}
      >
        {TRIGGER_TYPES.map((type) => (
          <option key={type} value={type}>
            {a.triggers[type]}
          </option>
        ))}
      </SelectField>
      {trigger.type === 'contact.tag_added' ? (
        <SelectField
          label={a.tag}
          value={value('tagId')}
          onChange={(event) => set({ tagId: event.target.value })}
          error={error('trigger.config.tagId')}
        >
          <option value="">{a.choose}</option>
          {options.tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      {trigger.type === 'form.submitted' ? optional('formId', a.form, options.forms) : null}
      {trigger.type === 'appointment.booked'
        ? optional('appointmentTypeId', a.appointmentType, options.appointmentTypes)
        : null}
      {trigger.type === 'deal.created' || trigger.type === 'deal.stage_changed' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={a.pipeline}
            value={value('pipelineId')}
            onChange={(event) => set({ pipelineId: event.target.value || null, toStageId: null })}
            error={error('trigger.config.pipelineId')}
          >
            <option value="">{a.anyValue}</option>
            {options.pipelines.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </SelectField>
          {trigger.type === 'deal.stage_changed' && pipeline ? (
            <SelectField
              label={a.stage}
              value={value('toStageId')}
              onChange={(event) => set({ toStageId: event.target.value || null })}
              error={error('trigger.config.toStageId')}
            >
              <option value="">{a.anyValue}</option>
              {pipeline.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
      ) : null}
      {trigger.type === 'message.received' ? (
        <SelectField
          label={a.channel}
          value={value('channel')}
          onChange={(event) => set({ channel: event.target.value || null })}
        >
          <option value="">{a.anyValue}</option>
          {(['email', 'whatsapp', 'sms'] as const).map((channel) => (
            <option key={channel} value={channel}>
              {a.channels[channel]}
            </option>
          ))}
        </SelectField>
      ) : null}
      {trigger.type === 'contact.updated' ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-800">
            {a.whenFieldsChange}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {CONTACT_FIELDS.map((field) => {
              const fields = Array.isArray(config.fields) ? (config.fields as string[]) : [];
              return (
                <CheckboxField
                  key={field}
                  label={field}
                  checked={fields.includes(field)}
                  onChange={(event) =>
                    set({
                      fields: event.target.checked
                        ? [...fields, field]
                        : fields.filter((entry) => entry !== field),
                    })
                  }
                />
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
