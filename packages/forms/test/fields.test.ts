import { CustomFieldSet } from '@businessos/crm';
import type { CrmCustomField, FormField } from '@businessos/database';
import { ProviderError, ValidationError } from '@businessos/shared';
import { describe, expect, it } from 'vitest';
import {
  answersAsText,
  captchaFromEnv,
  FakeCaptchaVerifier,
  fieldInputSchema,
  formSettingsSchema,
  mapAnswers,
  mappingProblems,
  MIN_FILL_MS,
  spamReasons,
  toPublicField,
  TurnstileVerifier,
  validateAnswers,
} from '../src';

let position = 0;
function field(input: Parameters<typeof fieldInputSchema.parse>[0]): FormField {
  const parsed = fieldInputSchema.parse(input);
  return {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    key: parsed.key,
    type: parsed.type,
    label: parsed.label,
    required: parsed.required,
    position: position++,
    placeholder: parsed.placeholder ?? null,
    helpText: parsed.helpText ?? null,
    options: parsed.options,
    validation: parsed.validation,
    defaultValue: parsed.defaultValue ?? null,
    target: parsed.target ?? null,
  };
}

function errorPaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return (error.details ?? []).map((d) => d.path);
    throw error;
  }
  throw new Error('expected a validation error');
}

const sizes = [
  { value: 'small', label: '1–10' },
  { value: 'large', label: '11+' },
];

describe('field definitions', () => {
  it('requires options exactly for choice fields and unique option values', () => {
    expect(fieldInputSchema.safeParse({ key: 'size', type: 'select', label: 'Size' }).success).toBe(
      false,
    );
    expect(
      fieldInputSchema.safeParse({ key: 'name', type: 'text', label: 'Name', options: sizes })
        .success,
    ).toBe(false);
    expect(
      fieldInputSchema.safeParse({
        key: 'size',
        type: 'radio',
        label: 'Size',
        options: [sizes[0], sizes[0]],
      }).success,
    ).toBe(false);
    expect(
      fieldInputSchema.safeParse({ key: 'size', type: 'radio', label: 'Size', options: sizes })
        .success,
    ).toBe(true);
  });

  it('rejects unsafe keys, inverted ranges and required hidden fields', () => {
    for (const key of ['Email', '1st', '__proto__x', 'a-b', 'x'.repeat(41)]) {
      expect(fieldInputSchema.safeParse({ key, type: 'text', label: 'X' }).success).toBe(false);
    }
    expect(
      fieldInputSchema.safeParse({
        key: 'n',
        type: 'number',
        label: 'N',
        validation: { min: 5, max: 1 },
      }).success,
    ).toBe(false);
    expect(
      fieldInputSchema.safeParse({ key: 'utm', type: 'hidden', label: 'UTM', required: true })
        .success,
    ).toBe(false);
  });

  it('exposes no mapping targets publicly and only hidden fields keep defaults', () => {
    const email = toPublicField(
      field({ key: 'email', type: 'email', label: 'Email', target: 'contact.email' }),
    );
    expect(email).not.toHaveProperty('target');
    expect(
      toPublicField(field({ key: 'utm', type: 'hidden', label: 'UTM', defaultValue: 'ads' }))
        .defaultValue,
    ).toBe('ads');
  });
});

describe('answer validation', () => {
  const fields = [
    field({ key: 'name', type: 'text', label: 'Name', required: true }),
    field({ key: 'email', type: 'email', label: 'Email', required: true }),
    field({ key: 'phone', type: 'phone', label: 'Phone' }),
    field({ key: 'seats', type: 'number', label: 'Seats', validation: { min: 1, max: 500 } }),
    field({ key: 'start', type: 'date', label: 'Start' }),
    field({ key: 'size', type: 'select', label: 'Size', options: sizes }),
    field({
      key: 'topics',
      type: 'multi_select',
      label: 'Topics',
      options: [...sizes, { value: 'other', label: 'Other' }],
      validation: { maxSelections: 2 },
    }),
    field({ key: 'consent', type: 'consent', label: 'I agree', required: true }),
    field({ key: 'source', type: 'hidden', label: 'Source', defaultValue: 'website' }),
  ];

  it('normalizes values and drops anything that is not a field', () => {
    const answers = validateAnswers(
      fields,
      {
        name: '  Huda  ',
        email: ' Huda@Example.COM ',
        phone: '3312 3456',
        seats: '12.5',
        start: '2027-02-28',
        size: 'large',
        topics: ['small', 'small', 'other'],
        consent: 'on',
        ownerUserId: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
        __proto__: { polluted: true },
      },
      'BH',
    );
    expect(answers).toEqual({
      name: 'Huda',
      email: 'huda@example.com',
      phone: '+97333123456',
      seats: '12.5',
      start: '2027-02-28',
      size: 'large',
      topics: ['small', 'other'],
      consent: true,
      source: 'website',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports every problem with its field path', () => {
    const paths = errorPaths(() =>
      validateAnswers(
        fields,
        {
          email: 'not-an-email',
          phone: '12',
          seats: '1e9',
          start: '2027-02-30',
          size: 'huge',
          topics: ['small', 'large', 'other'],
          consent: false,
        },
        'BH',
      ),
    );
    expect(paths.sort()).toEqual(
      [
        'answers.name',
        'answers.email',
        'answers.phone',
        'answers.seats',
        'answers.start',
        'answers.size',
        'answers.topics',
        'answers.consent',
      ].sort(),
    );
  });

  it('enforces number ranges and text lengths', () => {
    expect(errorPaths(() => validateAnswers([fields[3]!], { seats: 0 }, 'BH'))).toEqual([
      'answers.seats',
    ]);
    const short = field({ key: 'note', type: 'text', label: 'Note', validation: { maxLength: 5 } });
    expect(errorPaths(() => validateAnswers([short], { note: 'too long' }, 'BH'))).toEqual([
      'answers.note',
    ]);
    expect(validateAnswers([short], { note: 'ok' }, 'BH')).toEqual({ note: 'ok' });
  });

  it('treats a non-object body as empty answers', () => {
    expect(errorPaths(() => validateAnswers(fields, ['x'], 'BH'))).toContain('answers.name');
    expect(validateAnswers([fields[2]!], 'nonsense', 'BH')).toEqual({});
  });
});

describe('form settings', () => {
  it('fills defaults and accepts strict https redirects and embed origins', () => {
    const settings = formSettingsSchema.parse({
      redirectUrl: 'https://example.com/thanks',
      embedOrigins: ['https://www.Example.com/', 'https://*.shop.bh', 'http://localhost:3000'],
    });
    expect(settings.contact).toMatchObject({ enabled: true, tagIds: [], addNote: false });
    expect(settings.embedOrigins).toEqual([
      'https://www.example.com',
      'https://*.shop.bh',
      'http://localhost:3000',
    ]);
  });

  it('refuses redirects and origins that could be abused', () => {
    for (const redirectUrl of [
      'javascript:alert(1)',
      'http://example.com/thanks',
      'https://user:pass@example.com/',
      'data:text/html,hi',
    ]) {
      expect(formSettingsSchema.safeParse({ redirectUrl }).success).toBe(false);
    }
    for (const origin of [
      '*',
      'https://example.com/path',
      "https://example.com; script-src 'unsafe-inline'",
      'https://example.com https://evil.com',
      'http://example.com',
      "'self'",
    ]) {
      expect(formSettingsSchema.safeParse({ embedOrigins: [origin] }).success).toBe(false);
    }
  });
});

function customField(
  key: string,
  type: CrmCustomField['type'],
  options: { value: string; label: string }[] = [],
): CrmCustomField {
  return {
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    entityType: 'contact',
    key,
    label: key,
    type,
    options,
    required: false,
    helpText: null,
    position: 0,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('CRM mapping', () => {
  const custom = new CustomFieldSet('contact', [
    customField('company_size', 'select', sizes),
    customField('budget', 'decimal'),
    { ...customField('old', 'text'), archivedAt: new Date() },
  ]);

  it('allows only listed properties and compatible types', () => {
    const problems = mappingProblems(
      [
        { key: 'a', type: 'email', options: [], target: 'contact.email' },
        { key: 'b', type: 'text', options: [], target: 'contact.ownerUserId' },
        { key: 'c', type: 'text', options: [], target: 'contact.lifecycleStage' },
        { key: 'd', type: 'text', options: [], target: 'organizationId' },
        { key: 'e', type: 'number', options: [], target: 'contact.phone' },
        { key: 'f', type: 'select', options: sizes, target: 'contact.custom.company_size' },
        { key: 'g', type: 'number', options: [], target: 'contact.custom.budget' },
        { key: 'h', type: 'text', options: [], target: 'contact.custom.old' },
        { key: 'i', type: 'text', options: [], target: 'contact.custom.missing' },
        { key: 'j', type: 'email', options: [], target: 'contact.email' },
        {
          key: 'k',
          type: 'radio',
          options: [{ value: 'medium', label: 'M' }],
          target: 'contact.custom.company_size',
        },
      ],
      custom,
    );
    expect(problems.map((p) => p.path)).toEqual([
      'fields.1.target',
      'fields.2.target',
      'fields.3.target',
      'fields.4.target',
      'fields.7.target',
      'fields.8.target',
      'fields.9.target',
      'fields.10.target',
    ]);
  });

  it('refuses a full name together with first or last name', () => {
    expect(
      mappingProblems(
        [
          { key: 'a', type: 'text', options: [], target: 'contact.fullName' },
          { key: 'b', type: 'text', options: [], target: 'contact.lastName' },
        ],
        custom,
      ),
    ).toHaveLength(1);
  });

  it('maps answers by target and splits full names', () => {
    const fields = [
      field({ key: 'name', type: 'text', label: 'Name', target: 'contact.fullName' }),
      field({ key: 'email', type: 'email', label: 'Email', target: 'contact.email' }),
      field({
        key: 'size',
        type: 'select',
        label: 'Size',
        options: sizes,
        target: 'contact.custom.company_size',
      }),
      field({ key: 'message', type: 'textarea', label: 'Message' }),
    ];
    expect(
      mapAnswers(fields, {
        name: 'Huda bint Saleh',
        email: 'huda@example.com',
        size: 'large',
        message: 'Hi',
      }),
    ).toEqual({
      firstName: 'Huda',
      lastName: 'bint Saleh',
      email: 'huda@example.com',
      customFields: { company_size: 'large' },
    });
    expect(answersAsText('Contact us', fields, { name: 'Huda', size: 'large' })).toBe(
      'Form: Contact us\n\nName: Huda\nSize: 11+',
    );
  });
});

describe('spam heuristics', () => {
  const fields = [field({ key: 'message', type: 'textarea', label: 'Message' })];

  it('flags honeypots, instant submissions and link stuffing', () => {
    expect(spamReasons({ elapsedMs: MIN_FILL_MS + 1 }, fields, { message: 'Hello' })).toEqual([]);
    expect(
      spamReasons({ honeypot: 'http://spam', elapsedMs: 200 }, fields, {
        message: 'a https://1 b www.2 c http://3 d [url=4]',
      }),
    ).toEqual(['honeypot', 'too_fast', 'excessive_links']);
  });
});

describe('captcha', () => {
  it('is CONFIGURATION_REQUIRED without credentials and never uses the fake implicitly', () => {
    expect(captchaFromEnv({})).toBeNull();
    expect(captchaFromEnv({ TURNSTILE_SITE_KEY: 'site' })).toBeNull();
    expect(captchaFromEnv({ FORMS_FAKE_CAPTCHA: true })).toBeInstanceOf(FakeCaptchaVerifier);
    expect(
      captchaFromEnv({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' })?.provider,
    ).toBe('turnstile');
  });

  it('verifies Turnstile tokens server-side and fails closed when unreachable', async () => {
    const calls: { url: string; body: string }[] = [];
    const verifier = new TurnstileVerifier('site', 'secret', {
      fetch: (url, init) => {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : '';
        calls.push({ url: url instanceof URL ? url.href : (url as string), body });
        return Promise.resolve(Response.json({ success: body.includes('good') }));
      },
    });
    await expect(verifier.verify('good-token', '203.0.113.9')).resolves.toBe(true);
    await expect(verifier.verify('bad-token', '203.0.113.9')).resolves.toBe(false);
    await expect(verifier.verify('', '203.0.113.9')).resolves.toBe(false);
    expect(calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(calls[0]?.body).toContain('remoteip=203.0.113.9');
    const down = new TurnstileVerifier('site', 'secret', {
      fetch: () => Promise.reject(new Error('network')),
    });
    await expect(down.verify('token', '203.0.113.9')).rejects.toBeInstanceOf(ProviderError);
  });
});
