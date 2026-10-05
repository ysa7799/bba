import { resolvePublicForm, submitForm, type PublicForm } from '@businessos/forms';
import { NotFoundError, ProviderError, ValidationError } from '@businessos/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { RENDER_TOKEN, RenderTokenStore } from './render-tokens';

const slugParams = z.object({ slug: z.string().min(3).max(64) });
const submissionBody = z.object({
  renderToken: z.string().regex(RENDER_TOKEN),
  answers: z
    .record(z.string().max(60), z.unknown())
    .refine((answers) => Object.keys(answers).length <= 100, 'Too many answers'),
  /** Hidden from people; bots tend to fill it. */
  website: z.string().max(500).optional(),
  captchaToken: z.string().max(2_048).optional(),
});

const EXPIRED = 'This form has expired. Reload the page and try again.';

/**
 * `/public/forms/*` — unauthenticated form rendering and submission. The slug resolves the
 * tenant (system-scope lookup); everything else runs in that tenant. Loading a form issues a
 * render token; submitting requires one. Rate limited per client IP, submissions also per form.
 */
export function publicFormRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  async function load(request: FastifyRequest, slug: string): Promise<PublicForm> {
    await app.rateLimiter.consume('formReadIp', request.ip);
    const form = await resolvePublicForm(db(), slug);
    if (!form) throw new NotFoundError('Form');
    return form;
  }

  app.get('/:slug', async (request) => {
    const { slug } = parseInput(slugParams, request.params);
    const resolved = await load(request, slug);
    const renderToken = await app.forms.renderTokens.issue(resolved.form.id, resolved.versionId);
    const captcha = resolved.settings.captcha ? app.forms.captcha : null;
    return {
      form: {
        slug: resolved.form.slug,
        title: resolved.settings.title ?? resolved.form.name,
        description: resolved.settings.description,
        submitLabel: resolved.settings.submitLabel,
        fields: resolved.fields,
      },
      organization: { name: resolved.organization.name },
      renderToken,
      captcha: captcha ? { provider: captcha.provider, siteKey: captcha.siteKey } : null,
      /** False when the form needs a captcha that is no longer configured. */
      accepting: !resolved.settings.captcha || captcha !== null,
    };
  });

  /** Who may frame the form (read by the web app to set CSP `frame-ancestors`). */
  app.get('/:slug/embed-policy', async (request) => {
    const { slug } = parseInput(slugParams, request.params);
    const resolved = await load(request, slug);
    return { frameAncestors: resolved.settings.embedOrigins };
  });

  app.post('/:slug/submissions', { bodyLimit: 65_536 }, async (request, reply) => {
    const { slug } = parseInput(slugParams, request.params);
    await app.rateLimiter.consume('formSubmitIp', request.ip);
    const body = parseInput(submissionBody, request.body);
    const resolved = await load(request, slug);
    await app.rateLimiter.consume('formSubmitForm', resolved.form.id);
    const claims = await app.forms.renderTokens.read(body.renderToken);
    if (claims?.formId !== resolved.form.id) {
      throw new ValidationError(EXPIRED, [{ path: 'renderToken', message: EXPIRED }]);
    }
    if (resolved.settings.captcha) {
      const verifier = app.forms.captcha;
      if (!verifier) {
        throw new ProviderError('captcha', 'This form cannot accept submissions right now');
      }
      const passed = body.captchaToken
        ? await verifier.verify(body.captchaToken, request.ip)
        : false;
      if (!passed) {
        throw new ValidationError('Please complete the verification', [
          { path: 'captchaToken', message: 'Verification failed' },
        ]);
      }
    }
    await submitForm(db(), {
      organizationId: resolved.organizationId,
      formId: resolved.form.id,
      versionId: claims.versionId,
      answers: body.answers,
      idempotencyKey: RenderTokenStore.digest(body.renderToken),
      signals: { honeypot: body.website, elapsedMs: Date.now() - claims.issuedAt },
      userAgent: request.headers['user-agent'] ?? null,
      correlationId: request.id,
    });
    // The same answer whether or not the submission was quarantined as spam.
    return reply.status(201).send({
      successMessage: resolved.settings.successMessage,
      redirectUrl: resolved.settings.redirectUrl,
    });
  });
}
