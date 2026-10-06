import type { AuditContext } from '@businessos/audit';
import { authenticateApiKey, bearerKey, type ApiCaller, type ApiScope } from '@businessos/api-keys';
import { requireFeature } from '@businessos/billing';
import { withTenant } from '@businessos/database';
import { ForbiddenError, UnauthenticatedError } from '@businessos/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientInfo } from '../lib/http';

/** The organization and scopes of the API key making a public API request. */
export type ApiCallerContext = ApiCaller;

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved API key, or null. Populated for `/api/v1/*` routes only. */
    apiCaller: ApiCallerContext | null;
  }
}

/**
 * Authenticates a public API request from its bearer key alone (no cookies, no client-supplied
 * organization): rate limits per key and per organization, and requires the organization's
 * plan to include the API.
 */
export async function resolveApiCaller(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<ApiCallerContext> {
  const presented = bearerKey(request.headers.authorization);
  if (!presented) {
    throw new UnauthenticatedError('Send your API key as "Authorization: Bearer <key>"');
  }
  const caller = await authenticateApiKey(app.deps.db.db, presented);
  if (!caller) {
    // Slows down anyone trying keys (they are 256-bit, but every attempt costs a lookup).
    await app.rateLimiter.consume('publicApiAuthFailureIp', request.ip);
    throw new UnauthenticatedError('Invalid, revoked or expired API key');
  }
  await app.rateLimiter.consume('publicApiKey', caller.apiKeyId);
  await app.rateLimiter.consume('publicApiOrg', caller.organizationId);
  await withTenant(app.deps.db.db, { organizationId: caller.organizationId, userId: null }, (tx) =>
    requireFeature(tx, caller.organizationId, 'api.enabled'),
  );
  request.apiCaller = caller;
  return caller;
}

export function requireApiCaller(request: FastifyRequest): ApiCallerContext {
  if (!request.apiCaller) throw new UnauthenticatedError();
  return request.apiCaller;
}

/** 403 unless the key was given the scope (its name is the permission it stands for). */
export function requireScope(request: FastifyRequest, scope: ApiScope): ApiCallerContext {
  const caller = requireApiCaller(request);
  if (!caller.scopes.has(scope)) {
    throw new ForbiddenError(`This API key does not have the ${scope} scope`);
  }
  return caller;
}

/** Audit context for changes made with an API key. */
export function apiAuditContext(request: FastifyRequest): AuditContext {
  const caller = requireApiCaller(request);
  const client = clientInfo(request);
  return {
    actorType: 'api_key',
    actorUserId: null,
    actorLabel: `API key ${caller.name} (${caller.prefix}…)`,
    ipAddress: client.ipAddress ?? null,
    userAgent: client.userAgent ?? null,
    requestId: request.id,
  };
}
