'use client';

import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Section } from '@/components/crm/detail';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { SelectField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import {
  FIELD_TYPES,
  type BuilderOptions,
  type FieldType,
  type FormDetail,
  type FormSettings,
  type FormVersionView,
} from '@/lib/forms-types';
import { keyFromLabel, newField, toEditable, toInput, type EditableField } from './builder-model';
import { FieldCard } from './field-card';
import { SettingsPanel } from './settings-panel';

type Notice = 'saved' | 'published' | null;

/**
 * Edits the form's draft (or, when there is none, starts from the live version). Saving stores
 * a draft; publishing makes the saved draft live. The API validates everything again.
 */
export function FormBuilder({
  form,
  source,
  options,
}: {
  form: FormDetail;
  /** The version being edited: the draft, or the live version when there is no draft. */
  source: FormVersionView;
  options: BuilderOptions;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [fields, setFields] = useState<EditableField[]>(() =>
    source.fields.map((field, index) => toEditable(field, `initial-${index}`)),
  );
  const [settings, setSettings] = useState<FormSettings>(source.settings);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [newType, setNewType] = useState<FieldType>('text');
  const [nextUid, setNextUid] = useState(0);
  const [confirm, setConfirm] = useState<'discard' | null>(null);
  const base = `/app/orgs/${organizationId}/forms/${form.id}`;
  const errorFor = (path: string) => error?.fieldError(path);

  function touch() {
    setDirty(true);
    setNotice(null);
  }

  function update(uid: string, patch: Partial<EditableField>) {
    setFields((current) =>
      current.map((field) => {
        if (field.uid !== uid) return field;
        const next = { ...field, ...patch };
        if (patch.label !== undefined && !field.keyEdited) {
          const taken = new Set(current.filter((f) => f.uid !== uid).map((f) => f.key));
          next.key = keyFromLabel(patch.label, taken);
        }
        return next;
      }),
    );
    touch();
  }

  function move(index: number, delta: -1 | 1) {
    setFields((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + delta, 0, moved);
      return next;
    });
    touch();
  }

  function add() {
    const label = m.forms.types[newType];
    const key = keyFromLabel(label, new Set(fields.map((field) => field.key)));
    setFields((current) => [...current, newField(newType, label, key, `new-${nextUid}`)]);
    setNextUid((n) => n + 1);
    touch();
  }

  function body() {
    return {
      fields: fields.map(toInput),
      settings: {
        ...settings,
        embedOrigins: settings.embedOrigins.filter((origin) => origin.trim() !== ''),
      },
    };
  }

  async function save(): Promise<boolean> {
    const ok = await run(() => apiRequest(`${base}/draft`, { method: 'PUT', body: body() }));
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

  const canPublish = dirty || form.hasDraft;

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/95 px-4 py-3 sm:-mx-6 sm:px-6">
        <p className="text-sm text-slate-600" role="status">
          {dirty
            ? m.forms.unsaved
            : notice === 'saved'
              ? m.forms.saved
              : notice === 'published'
                ? m.forms.published
                : m.forms.publishHint}
        </p>
        <div className="flex flex-wrap gap-2">
          {form.hasDraft && form.published && !dirty ? (
            <Button variant="ghost" onClick={() => setConfirm('discard')}>
              {m.forms.discard}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => void save()}
            loading={pending}
            disabled={!dirty}
          >
            {m.forms.saveDraft}
          </Button>
          <Button onClick={() => void publish()} loading={pending} disabled={!canPublish}>
            {m.forms.publish}
          </Button>
        </div>
      </div>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title={m.forms.fields}>
          <ol className="space-y-3">
            {fields.map((field, index) => (
              <FieldCard
                key={field.uid}
                field={field}
                index={index}
                count={fields.length}
                targets={options.targets}
                errors={errorFor}
                onChange={(patch) => update(field.uid, patch)}
                onMove={(delta) => move(index, delta)}
                onRemove={() => {
                  setFields((current) => current.filter((entry) => entry.uid !== field.uid));
                  touch();
                }}
              />
            ))}
          </ol>
          {errorFor('fields') ? (
            <p className="mt-2 text-sm text-red-600">{errorFor('fields')}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <SelectField
              label={m.forms.fieldType}
              value={newType}
              onChange={(event) => setNewType(event.target.value as FieldType)}
              className="w-48"
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {m.forms.types[type]}
                </option>
              ))}
            </SelectField>
            <Button variant="secondary" onClick={add} disabled={fields.length >= 50}>
              {m.forms.addField}
            </Button>
          </div>
        </Section>
        <Section title={m.forms.settings}>
          <SettingsPanel
            settings={settings}
            options={options}
            errors={errorFor}
            onChange={(next) => {
              setSettings(next);
              touch();
            }}
          />
        </Section>
      </div>
      <ConfirmDialog
        open={confirm === 'discard'}
        title={m.forms.discard}
        message={m.forms.discardConfirm}
        confirmLabel={m.forms.discard}
        cancelLabel={m.common.cancel}
        pending={pending}
        error={error?.message ?? null}
        onConfirm={() =>
          void run(async () => {
            const result = await apiRequest<{ form: FormDetail }>(`${base}/draft`, {
              method: 'DELETE',
            });
            const live = result.form.published;
            if (live) {
              setFields(live.fields.map((field, index) => toEditable(field, `live-${index}`)));
              setSettings(live.settings);
            }
          }).then((ok) => {
            if (ok) {
              setConfirm(null);
              setDirty(false);
              reset();
            }
          })
        }
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
