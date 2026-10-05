import { ForbiddenError } from '@businessos/shared';
import type { FastifyInstance } from 'fastify';
import { allowedOrigins } from '../env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF defence for cookie-authenticated routes (`/app/*`): session cookies are SameSite=Lax and
 * every state-changing request must come from an allowed Origin (or Referer when Origin is
 * absent). Requests without either header are rejected. Bodies must be JSON (other content
 * types are refused by the parser), which also rules out simple cross-site form posts.
 */
export function registerCsrfProtection(app: FastifyInstance): void {
  const origins = allowedOrigins(app.deps.env);
  app.addHook('onRequest', (request, _reply, done) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/app/')) {
      done();
      return;
    }
    const origin =
      originOf(request.headers.origin) ??
      originOf(typeof request.headers.referer === 'string' ? request.headers.referer : undefined);
    if (origin === null || !origins.has(origin)) {
      done(new ForbiddenError('Cross-site request blocked'));
      return;
    }
    done();
  });
}
