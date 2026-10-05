'use client';

import Script from 'next/script';
import { useEffect, useState, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { PublicField, PublicFormView } from '@/lib/forms-types';

type Value = string | string[] | boolean;

const INPUT_TYPES: Partial<Record<PublicField['type'], string>> = {
  text: 'text',
  email: 'email',
  phone: 'tel',
  number: 'number',
  date: 'date',
};

function isEmpty(value: Value | undefined): boolean {
  return (
    value === undefined ||
    value === false ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Tells an embedding page how tall the form is (no data other than the height is sent). */
function useReportHeight(enabled: boolean) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;
    const post = () =>
      window.parent.postMessage(
        { type: 'businessos:form:height', height: document.documentElement.scrollHeight },
        '*',
      );
    const observer = new ResizeObserver(post);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [enabled]);
}

/**
 * Renders a published form for anonymous visitors and submits it with the server-issued render
 * token. Spam checks happen on the server; this component never learns the outcome.
 */
export function PublicForm({
  slug,
  view,
  embed,
  prefill,
}: {
  slug: string;
  view: PublicFormView;
  embed: boolean;
  prefill: Record<string, string>;
}) {
  const m = useMessages();
  const [values, setValues] = useState<Record<string, Value>>({});
  const [website, setWebsite] = useState('');
  const [fakeCaptcha, setFakeCaptcha] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState<{ successMessage: string; redirectUrl: string | null } | null>(
    null,
  );
  useReportHeight(embed);

  if (!view.accepting) return <Alert tone="info">{m.forms.public.unavailable}</Alert>;
  if (expired) {
    return (
      <div className="space-y-3">
        <Alert tone="info">{m.forms.public.expired}</Alert>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {m.forms.public.reload}
        </Button>
      </div>
    );
  }
  if (done) {
    return (
      <div className="space-y-3">
        <Alert tone="success">{done.successMessage}</Alert>
        {done.redirectUrl && embed ? (
          <a
            href={done.redirectUrl}
            target="_top"
            rel="noopener"
            className="text-sm font-medium text-brand-600 hover:underline"
          >
            {m.forms.public.continue} →
          </a>
        ) : null}
      </div>
    );
  }

  const set = (key: string, value: Value) => setValues((current) => ({ ...current, [key]: value }));
  const fieldError = (key: string) => error?.fieldError(`answers.${key}`);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const answers: Record<string, Value> = {};
    for (const field of view.form.fields) {
      const value =
        field.type === 'hidden'
          ? (prefill[field.key] ?? field.defaultValue ?? '')
          : values[field.key];
      if (!isEmpty(value) && value !== undefined) answers[field.key] = value;
    }
    const turnstile = new FormData(event.currentTarget).get('cf-turnstile-response');
    const captchaToken =
      view.captcha?.provider === 'fake'
        ? fakeCaptcha
          ? 'pass'
          : ''
        : typeof turnstile === 'string'
          ? turnstile
          : '';
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest<{ successMessage: string; redirectUrl: string | null }>(
        `/public/forms/${slug}/submissions`,
        {
          body: {
            renderToken: view.renderToken,
            answers,
            website,
            ...(captchaToken ? { captchaToken } : {}),
          },
        },
      );
      if (result.redirectUrl && !embed) {
        window.location.assign(result.redirectUrl);
        return;
      }
      setDone(result);
    } catch (caught) {
      const apiError =
        caught instanceof ApiError
          ? caught
          : new ApiError(0, 'unknown_error', 'Something went wrong. Please try again.');
      if (apiError.fieldError('renderToken')) setExpired(true);
      else setError(apiError);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error?.details.length === 0 ? <Alert tone="error">{error.message}</Alert> : null}
      {view.form.fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key]}
          error={fieldError(field.key)}
          chooseOne={m.forms.public.chooseOne}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
        <label>
          {m.forms.public.website}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </label>
      </div>
      {view.captcha?.provider === 'turnstile' ? (
        <>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
          <div className="cf-turnstile" data-sitekey={view.captcha.siteKey} />
        </>
      ) : null}
      {view.captcha?.provider === 'fake' ? (
        <CheckboxField
          label={m.forms.public.captcha}
          checked={fakeCaptcha}
          onChange={(event) => setFakeCaptcha(event.target.checked)}
        />
      ) : null}
      {error?.fieldError('captchaToken') ? (
        <p className="text-sm text-red-600">{error.fieldError('captchaToken')}</p>
      ) : null}
      <Button type="submit" loading={pending} className="w-full sm:w-auto">
        {pending ? m.forms.public.sending : view.form.submitLabel}
      </Button>
    </form>
  );
}

function FieldInput({
  field,
  value,
  error,
  chooseOne,
  onChange,
}: {
  field: PublicField;
  value: Value | undefined;
  error: string | undefined;
  chooseOne: string;
  onChange: (value: Value) => void;
}) {
  const label = field.required ? `${field.label} *` : field.label;
  const hint = field.helpText ?? undefined;
  const text = typeof value === 'string' ? value : '';
  const common = {
    name: field.key,
    required: field.required,
    'aria-required': field.required || undefined,
  };
  switch (field.type) {
    case 'hidden':
      return null;
    case 'textarea':
      return (
        <TextAreaField
          {...common}
          label={label}
          hint={hint}
          error={error}
          rows={5}
          value={text}
          placeholder={field.placeholder ?? undefined}
          maxLength={field.validation.maxLength ?? 10_000}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'select':
      return (
        <SelectField
          {...common}
          label={label}
          hint={hint}
          error={error}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{chooseOne}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      );
    case 'radio':
    case 'multi_select': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset aria-invalid={error ? true : undefined}>
          <legend className="mb-1.5 text-sm font-medium text-slate-800">{label}</legend>
          <div className="space-y-2">
            {field.options.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type={field.type === 'radio' ? 'radio' : 'checkbox'}
                  name={field.key}
                  value={option.value}
                  className={cn(
                    'h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600',
                    field.type === 'radio' ? '' : 'rounded',
                  )}
                  checked={
                    field.type === 'radio' ? text === option.value : selected.includes(option.value)
                  }
                  onChange={(event) =>
                    onChange(
                      field.type === 'radio'
                        ? option.value
                        : event.target.checked
                          ? [...selected, option.value]
                          : selected.filter((entry) => entry !== option.value),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
          {error ? (
            <p className="mt-1 text-sm text-red-600">{error}</p>
          ) : hint ? (
            <p className="mt-1 text-sm text-slate-500">{hint}</p>
          ) : null}
        </fieldset>
      );
    }
    case 'checkbox':
    case 'consent':
      return (
        <div>
          <CheckboxField
            {...common}
            label={label}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          {error ? (
            <p className="mt-1 text-sm text-red-600">{error}</p>
          ) : hint ? (
            <p className="mt-1 text-sm text-slate-500">{hint}</p>
          ) : null}
        </div>
      );
    default:
      return (
        <TextField
          {...common}
          type={INPUT_TYPES[field.type] ?? 'text'}
          label={label}
          hint={hint}
          error={error}
          value={text}
          placeholder={field.placeholder ?? undefined}
          {...(field.type === 'number'
            ? {
                step: 'any',
                ...(field.validation.min !== undefined ? { min: field.validation.min } : {}),
                ...(field.validation.max !== undefined ? { max: field.validation.max } : {}),
              }
            : {})}
          {...(field.type === 'text' ? { maxLength: field.validation.maxLength ?? 500 } : {})}
          autoComplete={
            field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : undefined
          }
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
