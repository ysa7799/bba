import cookie from '@fastify/cookie';
import { validateSession, type AuthenticatedSession } from '@businessos/auth';
import { UnauthenticatedError } from '@businessos/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cookieSecure, type ApiEnv } from '../env';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved session, or null for anonymous requests. Populated for `/app/*` routes. */
    auth: AuthenticatedSession | null;
  }
}

export function sessionCookieName(env: ApiEnv): string {
  // `__Host-` binds the cookie to this exact host, HTTPS and path "/" (no Domain attribute).
  return cookieSecure(env) ? '__Host-bos_session' : 'bos_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  env: ApiEnv,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(sessionCookieName(env), token, {
    httpOnly: true,
    secure: cookieSecure(env),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: ApiEnv): void {
  void reply.clearCookie(sessionCookieName(env), {
    httpOnly: true,
    secure: cookieSecure(env),
    sameSite: 'lax',
    path: '/',
  });
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/app/')) return;
    const token = request.cookies[sessionCookieName(app.deps.env)];
    if (token === undefined) return;
    request.auth = await validateSession(app.deps.db.db, app.deps.authConfig, token);
    if (request.auth === null) {
      // Stale or revoked cookie: remove it so the browser stops sending it.
      clearSessionCookie(reply, app.deps.env);
    }
  });
}

/** Returns the session or throws 401. Use in every handler that needs a signed-in user. */
export function requireAuth(request: FastifyRequest): AuthenticatedSession {
  if (request.auth === null) throw new UnauthenticatedError();
  return request.auth;
}
