import { crmContacts, formSubmissions, withTenant } from '@businessos/database';
import { FakeCaptchaVerifier } from '@businessos/forms';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderTokenStore } from '../src/modules/forms/render-tokens';
import {
  createTestContext,
  loginAs,
  TEST_ORIGIN,
  type TestClient,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

const forms = (orgId: string, path = '') => `/app/orgs/${orgId}/forms${path}`;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

const draft = (overrides: Record<string, unknown> = {}) => ({
  fields: [
    { key: 'name', type: 'text', label: 'Name', required: true, target: 'contact.fullName' },
    { key: 'email', type: 'email', label: 'Email', required: true, target: 'contact.email' },
    { key: 'message', type: 'textarea', label: 'Message' },
  ],
  settings: {
    successMessage: 'Shukran! We will be in touch.',
    embedOrigins: ['https://shop.example.bh'],
  },
  ...overrides,
});

/** Creates and publishes a form in `orgId`; returns it with its public slug. */
async function publishedForm(
  context: TestContext = ctx,
  admin = world.orgA.users.owner,
  orgId = A,
  body: Record<string, unknown> = draft(),
) {
  const client = context === ctx ? await as(admin) : await loginAs(context, admin);
  const created = await client.post(forms(orgId), { name: `Enquiry ${uniqueSuffix()}` });
  expect(created.statusCode).toBe(201);
  const { form } = created.json();
  const saved = await client.put(forms(orgId, `/${form.id}/draft`), body);
  expect(saved.statusCode).toBe(200);
  const published = await client.post(forms(orgId, `/${form.id}/publish`));
  expect(published.statusCode).toBe(200);
  return { client, form: published.json().form };
}

/** Public visitor: loads the form (getting a render token) without cookies. */
async function render(context: TestContext, slug: string, ip = '198.51.100.7') {
  const response = await context.app.inject({
    method: 'GET',
    url: `/public/forms/${slug}`,
    remoteAddress: ip,
  });
  return response;
}

/** Pretends the visitor spent `ms` filling the form (the minimum fill time is server-side). */
async function age(context: TestContext, token: string, ms = 10_000) {
  const key = `${context.env.REDIS_KEY_PREFIX}forms:render:${RenderTokenStore.digest(token)}`;
  const claims = JSON.parse((await context.redis.get(key)) ?? '{}') as { issuedAt: number };
  claims.issuedAt -= ms;
  await context.redis.set(key, JSON.stringify(claims), 'KEEPTTL');
}

function submit(
  context: TestContext,
  slug: string,
  payload: Record<string, unknown>,
  ip = '198.51.100.7',
) {
  return context.app.inject({
    method: 'POST',
    url: `/public/forms/${slug}/submissions`,
    payload,
    remoteAddress: ip,
    headers: { origin: TEST_ORIGIN },
  });
}

describe('form permissions', () => {
  it('lets managers build, members read submissions and restricted users only view forms', async () => {
    const { form } = await publishedForm();
    const sales = await as(world.orgA.users.sales);
    const restricted = await as(world.orgA.users.restricted);

    expect((await restricted.get(forms(A))).statusCode).toBe(200);
    expect((await restricted.get(forms(A, `/${form.id}`))).statusCode).toBe(200);
    expect((await restricted.get(forms(A, `/${form.id}/submissions`))).statusCode).toBe(403);
    expect((await sales.get(forms(A, `/${form.id}/submissions`))).statusCode).toBe(200);
    for (const client of [sales, restricted]) {
      expect((await client.post(forms(A), { name: 'Nope' })).statusCode).toBe(403);
      expect((await client.put(forms(A, `/${form.id}/draft`), draft())).statusCode).toBe(403);
      expect((await client.post(forms(A, `/${form.id}/publish`))).statusCode).toBe(403);
      expect((await client.post(forms(A, `/${form.id}/archive`))).statusCode).toBe(403);
      expect((await client.get(forms(A, '/builder-options'))).statusCode).toBe(403);
    }
    const manager = await as(world.orgA.users.manager);
    const options = (await manager.get(forms(A, '/builder-options'))).json();
    expect(options.captcha).toEqual({ status: 'CONFIGURATION_REQUIRED', provider: null });
    const targets = options.targets.map((t: { target: string }) => t.target);
    expect(targets).toContain('contact.email');
    expect(targets).not.toContain('contact.ownerUserId');
  });

  it('ignores privileged fields sent by staff clients and audits changes', async () => {
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(forms(A), {
      name: 'Mass assignment',
      organizationId: B,
      status: 'archived',
      createdByUserId: world.orgB.users.owner.id,
    });
    expect(created.statusCode).toBe(201);
    const { form } = created.json();
    expect(form.status).toBe('active');
    const listedInB = (await (await as(world.orgB.users.owner)).get(forms(B))).json();
    expect(listedInB.data.map((f: { id: string }) => f.id)).not.toContain(form.id);
    const audit = (await owner.get(`/app/orgs/${A}/audit-logs?action=forms.form.created`)).json();
    expect(audit.data.some((entry: { targetId: string }) => entry.targetId === form.id)).toBe(true);
  });
});

describe('public forms', () => {
  it('renders, accepts a submission and creates the CRM contact', async () => {
    const { client, form } = await publishedForm();
    const rendered = await render(ctx, form.slug);
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['cache-control']).toBe('no-store');
    const body = rendered.json();
    expect(body.form.fields.map((f: { key: string }) => f.key)).toEqual([
      'name',
      'email',
      'message',
    ]);
    // Mapping targets, settings and identifiers stay server-side.
    expect(JSON.stringify(body)).not.toContain('contact.');
    expect(body).not.toHaveProperty('organizationId');
    expect(body.captcha).toBeNull();
    expect(body.renderToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await age(ctx, body.renderToken);
    const email = `visitor-${uniqueSuffix()}@example.com`.toLowerCase();
    const response = await submit(ctx, form.slug, {
      renderToken: body.renderToken,
      answers: {
        name: 'Zainab Ali',
        email,
        message: 'Price list please',
        ownerUserId: world.orgA.users.owner.id,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      successMessage: 'Shukran! We will be in touch.',
      redirectUrl: null,
    });
    // Double submit of the same rendered form: one submission.
    expect(
      (
        await submit(ctx, form.slug, {
          renderToken: body.renderToken,
          answers: { name: 'Zainab Ali', email },
        })
      ).statusCode,
    ).toBe(201);

    const list = (await client.get(forms(A, `/${form.id}/submissions`))).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].contact.name).toBe('Zainab Ali');
    const detail = (
      await client.get(forms(A, `/${form.id}/submissions/${list.data[0].id}`))
    ).json();
    expect(detail.submission.answers.map((a: { key: string }) => a.key)).toEqual([
      'name',
      'email',
      'message',
    ]);
    const [contact] = await withTenant(ctx.db.db, { organizationId: A, userId: null }, (tx) =>
      tx
        .select()
        .from(crmContacts)
        .where(and(eq(crmContacts.organizationId, A), eq(crmContacts.email, email))),
    );
    expect(contact).toMatchObject({ source: 'form', ownerUserId: null });
    expect(
      (await client.get(forms(A))).json().data.find((f: { id: string }) => f.id === form.id),
    ).toMatchObject({ submissionCount: 1 });
  });

  it('validates answers and refuses missing, forged or foreign render tokens', async () => {
    const { form } = await publishedForm();
    const { form: other } = await publishedForm();
    const token = (await render(ctx, form.slug)).json().renderToken as string;
    await age(ctx, token);

    const invalid = await submit(ctx, form.slug, { renderToken: token, answers: { email: 'x' } });
    expect(invalid.statusCode).toBe(400);
    expect(
      invalid
        .json()
        .error.details.map((d: { path: string }) => d.path)
        .sort(),
    ).toEqual(['answers.email', 'answers.name']);
    for (const renderToken of [
      'A'.repeat(43),
      'short',
      token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'),
    ]) {
      const forged = await submit(ctx, form.slug, {
        renderToken,
        answers: { name: 'X', email: 'x@example.com' },
      });
      expect(forged.statusCode).toBe(400);
    }
    const foreign = await submit(ctx, other.slug, {
      renderToken: token,
      answers: { name: 'X', email: 'x@example.com' },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.message).toContain('expired');
    const missing = await submit(ctx, form.slug, { answers: { name: 'X' } });
    expect(missing.statusCode).toBe(400);
    expect((await submit(ctx, form.slug, { renderToken: token, answers: 'nope' })).statusCode).toBe(
      400,
    );
  });

  it('quarantines honeypot and instant submissions while answering as usual', async () => {
    const { client, form } = await publishedForm();
    const instant = (await render(ctx, form.slug)).json().renderToken as string;
    const fast = await submit(ctx, form.slug, {
      renderToken: instant,
      answers: { name: 'Speedy', email: `fast-${uniqueSuffix()}@example.com` },
    });
    const trapped = (await render(ctx, form.slug)).json().renderToken as string;
    await age(ctx, trapped);
    const honeypot = await submit(ctx, form.slug, {
      renderToken: trapped,
      website: 'https://spam.example',
      answers: { name: 'Bot', email: `bot-${uniqueSuffix()}@example.com` },
    });
    expect(fast.statusCode).toBe(201);
    expect(honeypot.statusCode).toBe(201);
    expect(honeypot.json()).toEqual(fast.json());
    const spam = (await client.get(forms(A, `/${form.id}/submissions?status=spam`))).json();
    expect(spam.data).toHaveLength(2);
    expect((await client.get(forms(A, `/${form.id}/submissions`))).json().data).toHaveLength(0);
    const detail = (
      await client.get(forms(A, `/${form.id}/submissions/${spam.data[0].id}`))
    ).json();
    expect(detail.submission.contact).toBeNull();

    const released = await client.post(
      forms(A, `/${form.id}/submissions/${spam.data[0].id}/release`),
    );
    expect(released.statusCode).toBe(200);
    expect(released.json().submission.status).toBe('accepted');
    const sales = await as(world.orgA.users.sales);
    expect(
      (await sales.post(forms(A, `/${form.id}/submissions/${spam.data[1].id}/release`))).statusCode,
    ).toBe(403);
  });

  it('takes archived and unpublished forms offline and exposes the embed policy', async () => {
    const { client, form } = await publishedForm();
    const policy = await ctx.app.inject({
      method: 'GET',
      url: `/public/forms/${form.slug}/embed-policy`,
    });
    expect(policy.json()).toEqual({ frameAncestors: ['https://shop.example.bh'] });
    const token = (await render(ctx, form.slug)).json().renderToken as string;
    await age(ctx, token);
    expect((await client.post(forms(A, `/${form.id}/archive`))).statusCode).toBe(200);
    expect((await render(ctx, form.slug)).statusCode).toBe(404);
    expect(
      (
        await submit(ctx, form.slug, {
          renderToken: token,
          answers: { name: 'Late', email: 'late@example.com' },
        })
      ).statusCode,
    ).toBe(404);
    const draftOnly = (await client.post(forms(A), { name: 'Never published' })).json().form;
    expect((await render(ctx, draftOnly.slug)).statusCode).toBe(404);
    expect((await render(ctx, 'no-such-form-here')).statusCode).toBe(404);
  });
});

describe('tenant isolation over HTTP', () => {
  it('hides one organization’s forms and submissions from another', async () => {
    const { form } = await publishedForm();
    const bAdmin = await as(world.orgB.users.owner);
    expect((await bAdmin.get(forms(A))).statusCode).toBe(404);
    expect((await bAdmin.get(forms(B, `/${form.id}`))).statusCode).toBe(404);
    expect((await bAdmin.patch(forms(B, `/${form.id}`), { name: 'Mine now' })).statusCode).toBe(
      404,
    );
    expect((await bAdmin.put(forms(B, `/${form.id}/draft`), draft())).statusCode).toBe(404);
    expect((await bAdmin.post(forms(B, `/${form.id}/publish`))).statusCode).toBe(404);
    expect((await bAdmin.post(forms(B, `/${form.id}/archive`))).statusCode).toBe(404);
    expect((await bAdmin.get(forms(B, `/${form.id}/submissions`))).statusCode).toBe(404);

    // B cannot point its form at A's tags, pipelines or members either.
    const aOptions = (
      await (await as(world.orgA.users.owner)).get(forms(A, '/builder-options'))
    ).json();
    const bForm = (await bAdmin.post(forms(B), { name: 'B form' })).json().form;
    const foreign = await bAdmin.put(
      forms(B, `/${bForm.id}/draft`),
      draft({
        settings: {
          contact: { ownerUserId: world.orgA.users.owner.id },
          deal: { pipelineId: aOptions.pipelines[0].id },
        },
      }),
    );
    expect(foreign.statusCode).toBe(400);
    const rows = await withTenant(ctx.db.db, { organizationId: B, userId: null }, (tx) =>
      tx.select().from(formSubmissions).where(eq(formSubmissions.formId, form.id)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('spam gate: rate limits and captcha', () => {
  it('rate limits submissions per IP', async () => {
    const strict = await createTestContext({ strictRateLimits: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        statuses.push(
          (
            await submit(
              strict,
              'some-form-slug',
              { renderToken: 'x', answers: {} },
              '203.0.113.50',
            )
          ).statusCode,
        );
      }
      expect(statuses.slice(0, 20).every((status) => status !== 429)).toBe(true);
      expect(statuses[20]).toBe(429);
      // Another visitor is unaffected.
      expect(
        (await submit(strict, 'some-form-slug', { renderToken: 'x', answers: {} }, '203.0.113.51'))
          .statusCode,
      ).not.toBe(429);
    } finally {
      await strict.close();
    }
  });

  it('requires a verified captcha when the form asks for one', async () => {
    const withCaptcha = await createTestContext({ captcha: new FakeCaptchaVerifier() });
    try {
      const owner = await loginAs(withCaptcha, world.orgA.users.owner);
      const options = (await owner.get(forms(A, '/builder-options'))).json();
      expect(options.captcha).toEqual({ status: 'CONFIGURED', provider: 'fake' });
      const { form } = await publishedForm(
        withCaptcha,
        world.orgA.users.owner,
        A,
        draft({ settings: { captcha: true } }),
      );
      const rendered = (await render(withCaptcha, form.slug)).json();
      expect(rendered.captcha).toEqual({ provider: 'fake', siteKey: 'fake-site-key' });
      await age(withCaptcha, rendered.renderToken);
      const answers = { name: 'Captcha Person', email: `captcha-${uniqueSuffix()}@example.com` };
      for (const captchaToken of [undefined, 'fail']) {
        const refused = await submit(withCaptcha, form.slug, {
          renderToken: rendered.renderToken,
          answers,
          ...(captchaToken ? { captchaToken } : {}),
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error.details[0].path).toBe('captchaToken');
      }
      expect(
        (
          await submit(withCaptcha, form.slug, {
            renderToken: rendered.renderToken,
            answers,
            captchaToken: 'pass',
          })
        ).statusCode,
      ).toBe(201);
    } finally {
      await withCaptcha.close();
    }
    // Without a provider, a form cannot be set to require one.
    const owner = await as(world.orgA.users.owner);
    const form = (await owner.post(forms(A), { name: 'Captcha required' })).json().form;
    const refused = await owner.put(
      forms(A, `/${form.id}/draft`),
      draft({ settings: { captcha: true } }),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details[0].path).toBe('settings.captcha');
  });
});
