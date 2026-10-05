import type { SessionClientInfo } from '@businessos/auth';
import type { FastifyRequest } from 'fastify';

export function clientInfo(request: FastifyRequest): SessionClientInfo {
  const userAgent = request.headers['user-agent'];
  return { ipAddress: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}
