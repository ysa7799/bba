import { recordAudit } from '@businessos/audit';
import { withTenant, FILE_ENTITY_TYPES } from '@businessos/database';
import {
  deleteFile,
  ENTITY_PERMISSIONS,
  getFileRow,
  isInlineType,
  listFiles,
  MAX_FILE_BYTES,
  readFileContent,
  uploadFile,
  type FileEntity,
} from '@businessos/files';
import { ForbiddenError, NotFoundError } from '@businessos/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requireTenant,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';

const entityQuery = z.object({
  entityType: z.enum(FILE_ENTITY_TYPES),
  entityId: z.uuid(),
});
const uploadQuery = entityQuery.extend({ name: z.string().trim().min(1).max(500) });
const idParams = z.object({ id: z.uuid() });
const contentQuery = z.object({ inline: z.enum(['1']).optional() });

function allow(tenant: TenantContext, entity: FileEntity, access: 'read' | 'write'): void {
  const permission = ENTITY_PERMISSIONS[entity.type][access];
  if (!tenant.permissions.has(permission)) throw new ForbiddenError();
}

/** `Content-Disposition` with an ASCII fallback and the exact UTF-8 name (RFC 6266/5987). */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * `/app/orgs/:orgId/files` — attachments on CRM records. Access follows the record: reading
 * needs its read permission, uploading and deleting its update permission.
 */
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const db = () => app.deps.db.db;

  // Raw uploads (the body is the file); everything else stays JSON.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  async function fileFor(request: FastifyRequest, tenant: TenantContext, id: string) {
    const row = await withTenant(db(), tenantScope(tenant), (tx) =>
      getFileRow(tx, tenant.organizationId, id),
    );
    // Only attachments are served; access follows the record they belong to.
    if (!row.entityType || !row.entityId) throw new NotFoundError('File');
    return { row, entity: { type: row.entityType, id: row.entityId } satisfies FileEntity };
  }

  app.get('/', async (request) => {
    const tenant = requireTenant(request);
    const query = parseInput(entityQuery, request.query);
    const entity = { type: query.entityType, id: query.entityId };
    allow(tenant, entity, 'read');
    return {
      data: await withTenant(db(), tenantScope(tenant), (tx) =>
        listFiles(tx, tenant.organizationId, entity),
      ),
    };
  });

  app.post('/', { bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
    const tenant = requireTenant(request);
    const query = parseInput(uploadQuery, request.query);
    const entity = { type: query.entityType, id: query.entityId };
    allow(tenant, entity, 'write');
    await app.rateLimiter.consume('fileUploadUser', tenant.userId);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const file = await uploadFile(app.files, tenantScope(tenant), {
      name: query.name,
      body,
      entity,
    });
    await withTenant(db(), tenantScope(tenant), (tx) =>
      recordAudit(tx, auditContext(request), {
        organizationId: tenant.organizationId,
        action: 'files.uploaded',
        target: { type: 'file', id: file.id },
        metadata: {
          entityType: entity.type,
          entityId: entity.id,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        },
      }),
    );
    return reply.status(201).send({ file });
  });

  app.get('/:id/content', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseInput(idParams, request.params);
    const { inline } = parseInput(contentQuery, request.query);
    const { row, entity } = await fileFor(request, tenant, id);
    allow(tenant, entity, 'read');
    const body = await readFileContent(app.files, row);
    const kind = inline && isInlineType(row.contentType) ? 'inline' : 'attachment';
    return reply
      .header('content-type', row.contentType)
      .header('content-disposition', disposition(kind, row.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
      .send(body);
  });

  app.delete('/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseInput(idParams, request.params);
    const { entity } = await fileFor(request, tenant, id);
    allow(tenant, entity, 'write');
    await deleteFile(app.files, tenantScope(tenant), id);
    await withTenant(db(), tenantScope(tenant), (tx) =>
      recordAudit(tx, auditContext(request), {
        organizationId: tenant.organizationId,
        action: 'files.deleted',
        target: { type: 'file', id },
        metadata: { entityType: entity.type, entityId: entity.id },
      }),
    );
    return reply.status(204).send();
  });
  await Promise.resolve();
}
