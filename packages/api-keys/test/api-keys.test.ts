import {
  apiIdempotencyKeys,
  apiKeys,
  memberships,
  organizations,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import { ALL_PERMISSIONS, type Permission } from '@businessos/permissions';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@businessos/shared';
import { createTestDatabase, createTestWorld, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticateApiKey,
  bearerKey,
  beginIdempotentRequest,
  completeIdempotentRequest,
  createApiKey,
  generateApiKey,
  hashApiKey,
  listApiKeys,
  MAX_ACTIVE_KEYS,
  parseIdempotencyKey,
  pruneIdempotencyKeys,
  releaseIdempotentRequest,
  requestFingerprint,
  revokeApiKey,
  type KeyManager,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const everything = new Set<Permission>(ALL_PERMISSIONS);

function manager(org: 'A' | 'B', permissions: ReadonlySet<Permission> = everything): KeyManager {
  const entry = org === 'A' ? world.orgA : world.orgB;
  return {
    organizationId: entry.organization.id,
    userId: entry.users.owner.id,
    permissions,
  };
}

function inTenant<T>(m: KeyManager, fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant(handle.db, { organizationId: m.organizationId, userId: m.userId }, fn);
}

describe('API keys', () => {
  it('issues a key once and stores only its hash', async () => {
    const owner = manager('A');
    const { apiKey, key } = await inTenant(owner, (tx) =>
      createApiKey(tx, owner, { name: 'Zapier', scopes: ['crm.contact.read', 'crm.contact.read'] }),
    );
    expect(key).toMatch(/^bos_[A-Za-z0-9_-]{43}$/);
    expect(apiKey).toMatchObject({
      name: 'Zapier',
      prefix: key.slice(0, 12),
      scopes: ['crm.contact.read'],
      status: 'active',
      expiresAt: null,
    });
    const [row] = await withSystem(handle.db, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)),
    );
    expect(row?.keyHash).toBe(hashApiKey(key));
    expect(JSON.stringify(row)).not.toContain(key);

    const caller = await authenticateApiKey(handle.db, key);
    expect(caller).toMatchObject({ apiKeyId: apiKey.id, organizationId: owner.organizationId });
    expect([...(caller?.scopes ?? [])]).toEqual(['crm.contact.read']);
  });

  it('never grants more than the creator holds', async () => {
    const limited = manager('A', new Set<Permission>(['crm.contact.read']));
    await expect(
      inTenant(limited, (tx) =>
        createApiKey(tx, limited, { name: 'x', scopes: ['crm.contact.read', 'crm.deal.read'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Only public API operations can be scopes at all.
    await expect(
      inTenant(manager('A'), (tx) =>
        createApiKey(tx, manager('A'), {
          name: 'x',
          scopes: ['settings.roles.manage' as 'crm.contact.read'],
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses unknown, revoked, expired and suspended-organization keys', async () => {
    const owner = manager('A');
    expect(await authenticateApiKey(handle.db, 'bos_short')).toBeNull();
    expect(await authenticateApiKey(handle.db, generateApiKey().key)).toBeNull();

    const { apiKey, key } = await inTenant(owner, (tx) =>
      createApiKey(tx, owner, { name: 'Revoked', scopes: ['crm.deal.read'] }),
    );
    const revoked = await inTenant(owner, (tx) =>
      revokeApiKey(tx, owner.organizationId, apiKey.id, owner.userId),
    );
    expect(revoked.status).toBe('revoked');
    expect(await authenticateApiKey(handle.db, key)).toBeNull();

    const expiring = await inTenant(owner, (tx) =>
      createApiKey(tx, owner, { name: 'Expiring', scopes: ['crm.deal.read'], expiresInDays: 1 }),
    );
    expect(await authenticateApiKey(handle.db, expiring.key)).not.toBeNull();
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(await authenticateApiKey(handle.db, expiring.key, later)).toBeNull();

    const other = manager('B');
    const suspended = await inTenant(other, (tx) =>
      createApiKey(tx, other, { name: 'B key', scopes: ['crm.deal.read'] }),
    );
    await withSystem(handle.db, (tx) =>
      tx
        .update(organizations)
        .set({ status: 'suspended' })
        .where(eq(organizations.id, other.organizationId)),
    );
    expect(await authenticateApiKey(handle.db, suspended.key)).toBeNull();
    await withSystem(handle.db, (tx) =>
      tx
        .update(organizations)
        .set({ status: 'active' })
        .where(eq(organizations.id, other.organizationId)),
    );
    expect(await authenticateApiKey(handle.db, suspended.key)).not.toBeNull();
  });

  it('never does more than its creator can do now', async () => {
    const organizationId = world.orgA.organization.id;
    const creator = world.orgA.users.restricted;
    // Stored scopes beyond what the restricted member actually holds are not usable.
    const restrictedManager: KeyManager = {
      organizationId,
      userId: creator.id,
      permissions: everything,
    };
    const { key } = await inTenant(restrictedManager, (tx) =>
      createApiKey(tx, restrictedManager, {
        name: 'Restricted creator',
        scopes: ['crm.contact.read', 'crm.contact.delete'],
      }),
    );
    const caller = await authenticateApiKey(handle.db, key);
    expect(caller?.scopes.has('crm.contact.read')).toBe(true);
    expect(caller?.scopes.has('crm.contact.delete')).toBe(false);

    // A creator who is no longer an active member takes the key down with them.
    const setStatus = (status: 'active' | 'suspended') =>
      withSystem(handle.db, (tx) =>
        tx
          .update(memberships)
          .set({ status })
          .where(
            and(eq(memberships.userId, creator.id), eq(memberships.organizationId, organizationId)),
          ),
      );
    await setStatus('suspended');
    try {
      expect(await authenticateApiKey(handle.db, key)).toBeNull();
    } finally {
      await setStatus('active');
    }
    expect(await authenticateApiKey(handle.db, key)).not.toBeNull();
  });

  it('records use at most once a minute', async () => {
    const owner = manager('A');
    const { apiKey, key } = await inTenant(owner, (tx) =>
      createApiKey(tx, owner, { name: 'Used', scopes: ['crm.task.read'] }),
    );
    const first = new Date('2030-01-01T10:00:00Z');
    await authenticateApiKey(handle.db, key, first);
    await authenticateApiKey(handle.db, key, new Date(first.getTime() + 10_000));
    const lastUsed = async () =>
      (
        await withSystem(handle.db, (tx) =>
          tx.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)),
        )
      )[0]?.lastUsedAt?.toISOString();
    expect(await lastUsed()).toBe(first.toISOString());
    await authenticateApiKey(handle.db, key, new Date(first.getTime() + 61_000));
    expect(await lastUsed()).toBe(new Date(first.getTime() + 61_000).toISOString());
  });

  it('keeps keys inside their organization', async () => {
    const a = manager('A');
    const b = manager('B');
    const { apiKey } = await inTenant(a, (tx) =>
      createApiKey(tx, a, { name: 'A only', scopes: ['crm.contact.read'] }),
    );
    const seenByB = await inTenant(b, (tx) => listApiKeys(tx, b.organizationId));
    expect(seenByB.some((entry) => entry.id === apiKey.id)).toBe(false);
    // Neither by filter nor by RLS.
    const viaRls = await inTenant(b, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)),
    );
    expect(viaRls).toEqual([]);
    await expect(
      inTenant(b, (tx) => revokeApiKey(tx, b.organizationId, apiKey.id, b.userId)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(b, (tx) => revokeApiKey(tx, a.organizationId, apiKey.id, b.userId)),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stillActive = await inTenant(a, (tx) => listApiKeys(tx, a.organizationId));
    expect(stillActive.find((entry) => entry.id === apiKey.id)?.status).toBe('active');
  });

  it('limits active keys per organization', async () => {
    const b = manager('B');
    const existing = await inTenant(b, (tx) => listApiKeys(tx, b.organizationId));
    const active = existing.filter((entry) => entry.status === 'active').length;
    for (let index = active; index < MAX_ACTIVE_KEYS; index += 1) {
      await inTenant(b, (tx) =>
        createApiKey(tx, b, { name: `k${index}`, scopes: ['crm.task.read'] }),
      );
    }
    await expect(
      inTenant(b, (tx) => createApiKey(tx, b, { name: 'one too many', scopes: ['crm.task.read'] })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('reads bearer keys from the Authorization header', () => {
    expect(bearerKey('Bearer bos_abc')).toBe('bos_abc');
    expect(bearerKey('bearer   bos_abc ')).toBe('bos_abc');
    expect(bearerKey('Basic dXNlcg==')).toBeNull();
    expect(bearerKey(undefined)).toBeNull();
  });
});

describe('idempotency keys', () => {
  async function scope() {
    const owner = manager('A');
    const { apiKey } = await inTenant(owner, (tx) =>
      createApiKey(tx, owner, { name: 'Idempotent', scopes: ['crm.contact.create'] }),
    );
    return { organizationId: owner.organizationId, apiKeyId: apiKey.id };
  }

  it('replays a completed request and refuses a different one', async () => {
    const s = await scope();
    const print = requestFingerprint('post', '/api/v1/contacts', { firstName: 'Ali' });
    const first = await beginIdempotentRequest(handle.db, s, 'order-1', print);
    expect(first.kind).toBe('new');
    // The same key while the first is still running.
    await expect(beginIdempotentRequest(handle.db, s, 'order-1', print)).rejects.toBeInstanceOf(
      ConflictError,
    );
    if (first.kind !== 'new') throw new Error('expected a new request');
    await completeIdempotentRequest(handle.db, s, first.id, 201, { contact: { id: 'c1' } });
    expect(await beginIdempotentRequest(handle.db, s, 'order-1', print)).toEqual({
      kind: 'replay',
      status: 201,
      body: { contact: { id: 'c1' } },
    });
    const other = requestFingerprint('POST', '/api/v1/contacts', { firstName: 'Omar' });
    await expect(beginIdempotentRequest(handle.db, s, 'order-1', other)).rejects.toBeInstanceOf(
      UnprocessableError,
    );
  });

  it('releases failed requests and takes over abandoned ones', async () => {
    const s = await scope();
    const print = requestFingerprint('POST', '/api/v1/deals', {});
    const failed = await beginIdempotentRequest(handle.db, s, 'k', print);
    if (failed.kind !== 'new') throw new Error('expected a new request');
    await releaseIdempotentRequest(handle.db, s, failed.id);
    expect((await beginIdempotentRequest(handle.db, s, 'k', print)).kind).toBe('new');

    const later = new Date(Date.now() + 3 * 60_000);
    expect((await beginIdempotentRequest(handle.db, s, 'k', print, later)).kind).toBe('new');
  });

  it('is scoped to the key, validated and pruned after a day', async () => {
    const s1 = await scope();
    const s2 = await scope();
    const print = requestFingerprint('POST', '/x', {});
    expect((await beginIdempotentRequest(handle.db, s1, 'shared', print)).kind).toBe('new');
    expect((await beginIdempotentRequest(handle.db, s2, 'shared', print)).kind).toBe('new');
    expect(() => parseIdempotencyKey('has space')).toThrow(ValidationError);
    expect(() => parseIdempotencyKey('x'.repeat(256))).toThrow(ValidationError);
    expect(parseIdempotencyKey(undefined)).toBeNull();

    const removed = await pruneIdempotencyKeys(handle.db, new Date(Date.now() + 25 * 3_600_000));
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await withSystem(handle.db, (tx) =>
      tx.select().from(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.apiKeyId, s1.apiKeyId)),
    );
    expect(left).toEqual([]);
  });
});
