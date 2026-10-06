'use client';

import { useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, TextField } from '@/components/ui/field';
import type { ApiError } from '@/lib/api-client';

export interface EndpointFormValues {
  url: string;
  description: string;
  events: string[];
}

/** URL, description and subscribed events of a webhook endpoint (create and edit). */
export function EndpointForm({
  eventTypes,
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  eventTypes: string[];
  initial: EndpointFormValues;
  pending: boolean;
  error: ApiError | null;
  submitLabel: string;
  onSubmit: (values: EndpointFormValues) => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const [url, setUrl] = useState(initial.url);
  const [description, setDescription] = useState(initial.description);
  const [events, setEvents] = useState<string[]>(initial.events);
  const groups = [...new Set(eventTypes.map((type) => type.split('.')[0] ?? type))];

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ url: url.trim(), description: description.trim(), events });
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && error.code !== 'validation_error' ? (
        <Alert tone="error">{error.message}</Alert>
      ) : null}
      <TextField
        label={m.developers.url}
        hint={m.developers.urlHint}
        type="url"
        dir="ltr"
        required
        maxLength={2000}
        autoFocus
        placeholder="https://example.com/webhooks/businessos"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        error={error?.fieldError('url')}
      />
      <TextField
        label={m.developers.description}
        maxLength={500}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <fieldset>
        <div className="mb-2 flex items-center justify-between gap-2">
          <legend className="text-sm font-medium text-slate-800">{m.developers.events}</legend>
          <span className="flex gap-3 text-xs">
            <button
              type="button"
              className="font-medium text-brand-700 hover:underline"
              onClick={() => setEvents(eventTypes)}
            >
              {m.developers.selectAll}
            </button>
            <button
              type="button"
              className="font-medium text-slate-600 hover:underline"
              onClick={() => setEvents([])}
            >
              {m.developers.clearAll}
            </button>
          </span>
        </div>
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-slate-200 p-3">
          {groups.map((group) => (
            <div key={group} className="grid gap-1 sm:grid-cols-2">
              {eventTypes
                .filter((type) => type.startsWith(`${group}.`))
                .map((type) => (
                  <CheckboxField
                    key={type}
                    label={type}
                    checked={events.includes(type)}
                    onChange={(event) =>
                      setEvents((current) =>
                        event.target.checked
                          ? [...current, type]
                          : current.filter((entry) => entry !== type),
                      )
                    }
                  />
                ))}
            </div>
          ))}
        </div>
        {error?.fieldError('events') ? (
          <p className="mt-1 text-sm text-red-600">{error.fieldError('events')}</p>
        ) : null}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {m.common.cancel}
        </Button>
        <Button type="submit" loading={pending} disabled={!url.trim() || events.length === 0}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
