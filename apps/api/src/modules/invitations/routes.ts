import {
  acceptInvitation,
  acceptInvitationAsNewUser,
  createSession,
  previewInvitation,
  revokeSession,
} from '@businessos/auth';
import { withSystem } from '@businessos/database';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientInfo } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import { requireAuth, setSessionCookie } from '../../plugins/session';

const tokenBodySchema = z.object({ token: z.string().min(1).max(256) });
const registerBodySchema = z.object({
  token: z.string().min(1).max(256),
  name: z.string().max(200),
  password: z.string().max(1024),
});

export function invitationRoutes(app: FastifyInstance): void {
  app.post('/preview', async (request) => {
    await app.rateLimiter.consume('invitationIp', request.ip);
    const { token } = parseInput(tokenBodySchema, request.body);
    return { invitation: await previewInvitation(app.deps.db.db, token) };
  });

  app.post('/accept', async (request) => {
    const auth = requireAuth(request);
    await app.rateLimiter.consume('invitationIp', request.ip);
    const { token } = parseInput(tokenBodySchema, request.body);
    return acceptInvitation(app.deps.db.db, auth.user, token, clientInfo(request));
  });

  app.post('/register', async (request, reply) => {
    await app.rateLimiter.consume('invitationIp', request.ip);
    const { token, name, password } = parseInput(registerBodySchema, request.body);
    const result = await acceptInvitationAsNewUser(
      { db: app.deps.db.db, config: app.deps.authConfig, mailer: app.deps.mailer },
      token,
      { name, password },
      clientInfo(request),
    );
    // System scope: issuing the first session for the account that was just created.
    const session = await withSystem(app.deps.db.db, (tx) =>
      createSession(tx, app.deps.authConfig, result.user.id, 'invitation', clientInfo(request)),
    );
    if (request.auth) await revokeSession(app.deps.db.db, request.auth.sessionId);
    setSessionCookie(reply, app.deps.env, session.token, session.expiresAt);
    return reply.status(201).send(result);
  });
}
