import {
  emailSchema,
  login,
  loginInputSchema,
  register,
  registerInputSchema,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  revokeSession,
  verifyEmail,
  type AuthServices,
} from '@businessos/auth';
import { UnauthenticatedError } from '@businessos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientInfo } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import { clearSessionCookie, setSessionCookie } from '../../plugins/session';

const tokenBodySchema = z.object({ token: z.string().min(1).max(256) });
const emailBodySchema = z.object({ email: z.string().max(320) });
const resetBodySchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().max(1024),
});

/** Identical response for every registration/recovery request (no account enumeration). */
const ACCEPTED = { status: 'accepted' } as const;

export function authRoutes(app: FastifyInstance): void {
  const services = (): AuthServices => ({
    db: app.deps.db.db,
    config: app.deps.authConfig,
    mailer: app.deps.mailer,
  });

  app.post('/register', async (request, reply) => {
    await app.rateLimiter.consume('registerIp', request.ip);
    const input = parseInput(registerInputSchema, request.body);
    await register(services(), input);
    return reply.status(202).send(ACCEPTED);
  });

  app.post('/verify-email', async (request) => {
    await app.rateLimiter.consume('verifyEmailIp', request.ip);
    const { token } = parseInput(tokenBodySchema, request.body);
    const user = await verifyEmail(services(), token);
    return { user };
  });

  app.post('/resend-verification', async (request, reply) => {
    await app.rateLimiter.consume('verifyEmailIp', request.ip);
    const { email } = parseInput(emailBodySchema, request.body);
    const parsed = emailSchema.safeParse(email);
    if (parsed.success) {
      await app.rateLimiter.consume('resendVerificationAccount', parsed.data);
      await resendVerification(services(), parsed.data);
    }
    return reply.status(202).send(ACCEPTED);
  });

  app.post('/login', async (request, reply) => {
    await app.rateLimiter.consume('loginIp', request.ip);
    const input = parseInput(loginInputSchema, request.body);
    await app.rateLimiter.assertBelow('loginAccountFailures', input.email);
    let result;
    try {
      result = await login(services(), input, clientInfo(request));
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        await app.rateLimiter.consume('loginAccountFailures', input.email);
      }
      throw error;
    }
    await app.rateLimiter.reset('loginAccountFailures', input.email);
    // A fresh session is always issued; drop any session the browser already had.
    if (request.auth) await revokeSession(app.deps.db.db, request.auth.sessionId);
    setSessionCookie(reply, app.deps.env, result.token, result.expiresAt);
    return { user: result.user };
  });

  app.post('/logout', async (request, reply) => {
    if (request.auth) await revokeSession(app.deps.db.db, request.auth.sessionId);
    clearSessionCookie(reply, app.deps.env);
    return reply.status(204).send();
  });

  app.post('/forgot-password', async (request, reply) => {
    await app.rateLimiter.consume('passwordResetIp', request.ip);
    const { email } = parseInput(emailBodySchema, request.body);
    const parsed = emailSchema.safeParse(email);
    if (parsed.success) {
      await app.rateLimiter.consume('passwordResetAccount', parsed.data);
      await requestPasswordReset(services(), parsed.data);
    }
    return reply.status(202).send(ACCEPTED);
  });

  app.post('/reset-password', async (request) => {
    await app.rateLimiter.consume('passwordResetIp', request.ip);
    const { token, password } = parseInput(resetBodySchema, request.body);
    const user = await resetPassword(services(), token, password);
    return { user };
  });
}
