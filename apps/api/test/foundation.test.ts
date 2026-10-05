import { InternalError, NotFoundError, ValidationError } from '@businessos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseInput } from '../src/lib/validation';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    env: { RATE_LIMIT_GLOBAL_PER_MINUTE: '1000' },
    configure: (app) => {
      app.get('/__test/boom', () => {
        throw new Error('database password is hunter2');
      });
      app.get('/__test/internal', () => {
        throw new InternalError('secret internals');
      });
      app.get('/__test/not-found', () => {
        throw new NotFoundError('Contact');
      });
      app.post('/__test/validate', (request) => {
        const body = parseInput(z.object({ name: z.string().min(1) }), request.body);
        return { ok: true, body };
      });
      app.get(
        '/__test/limited',
        { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
        () => ({
          ok: true,
        }),
      );
      app.get('/__test/validation-error', () => {
        throw new ValidationError('Bad', [{ path: 'x', message: 'nope' }]);
      });
    },
  });
  await ctx.redis.flushdb();
});

afterAll(async () => {
  await ctx.close();
});

describe('health endpoints', () => {
  it('reports liveness', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with database and redis checks', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });
});

describe('request ids', () => {
  it('generates a request id when none is supplied', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates well-formed upstream request ids and rejects malformed ones', async () => {
    const good = await ctx.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'upstream-req-12345' },
    });
    expect(good.headers['x-request-id']).toBe('upstream-req-12345');

    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': '<script>alert(1)</script>' },
    });
    expect(bad.headers['x-request-id']).not.toContain('<');
  });
});

describe('error handling', () => {
  it('returns a standard 404 envelope for unknown routes', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
  });

  it('never leaks internal error messages', async () => {
    for (const url of ['/__test/boom', '/__test/internal']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatchObject({
        code: 'internal_error',
        message: 'An unexpected error occurred',
      });
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('secret internals');
      expect(response.body).not.toContain('stack');
    }
  });

  it('maps application errors to their status and code', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/__test/not-found' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: 'not_found',
      message: 'Contact not found',
    });

    const validation = await ctx.app.inject({ method: 'GET', url: '/__test/validation-error' });
    expect(validation.statusCode).toBe(400);
    expect(validation.json().error.details).toEqual([{ path: 'x', message: 'nope' }]);
  });

  it('validates bodies and reports field paths', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/__test/validate',
      payload: { name: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    expect(response.json().error.details[0].path).toBe('name');
  });

  it('strips unknown keys (no mass assignment)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/__test/validate',
      payload: { name: 'ok', organizationId: 'attacker', role: 'owner' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().body).toEqual({ name: 'ok' });
  });

  it('rejects malformed JSON with a safe 400', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/__test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('bad_request');
  });

  it('rejects oversized bodies', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/__test/validate',
      payload: { name: 'x'.repeat(1_100_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('payload_too_large');
  });
});

describe('security middleware', () => {
  it('sets security headers', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('allows configured CORS origins only', async () => {
    const allowed = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits with a standard envelope and retry-after', async () => {
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await ctx.app.inject({ method: 'GET', url: '/__test/limited' });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.json().error.code).toBe('rate_limited');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('caching', () => {
  it('marks first-party app responses as non-cacheable', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/app/me' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
