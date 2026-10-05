import type { AuditContext } from '@businessos/audit';
import type { SessionClientInfo } from '@businessos/auth';
import type { FastifyRequest } from 'fastify';

export function clientInfo(request: FastifyRequest): SessionClientInfo {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: request.id,
  };
}

/** Audit context for the signed-in user making this request. */
export function auditContext(request: FastifyRequest): AuditContext {
  const client = clientInfo(request);
  return {
    actorType: request.auth ? 'user' : 'system',
    actorUserId: request.auth?.user.id ?? null,
    actorLabel: request.auth?.user.email ?? null,
    ipAddress: client.ipAddress ?? null,
    userAgent: client.userAgent ?? null,
    requestId: request.id,
  };
}
