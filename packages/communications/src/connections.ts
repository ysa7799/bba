import {
  channelConnections,
  isUniqueViolation,
  withSystem,
  type Channel,
  type ChannelConnection,
  type Database,
  type TenantTx,
} from '@businessos/database';
import { normalizeEmail, normalizePhone, type CrmContext } from '@businessos/crm';
import {
  ConflictError,
  newId,
  NotFoundError,
  ValidationError,
  type SecretBox,
} from '@businessos/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ChannelProviderRegistry } from './providers/registry';
import type { ChannelProvider, ResolvedConnection } from './types';

/** Platform services the communications domain needs (configured per deployment). */
export interface CommunicationsServices {
  providers: ChannelProviderRegistry;
  /** Null when credential encryption is not configured (credentials cannot be stored). */
  secretBox: SecretBox | null;
  /** Public API base URL used to build webhook URLs. */
  publicApiUrl: string;
}

/** Internal credential key holding the webhook token (so callback URLs can be rebuilt). */
const WEBHOOK_TOKEN_KEY = '__webhookToken';

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function webhookUrl(services: CommunicationsServices, provider: string, token: string): string {
  return `${services.publicApiUrl.replace(/\/$/, '')}/webhooks/communications/${provider}/${token}`;
}

function associatedData(organizationId: string, connectionId: string): string {
  return `channel_connection:${organizationId}:${connectionId}`;
}

export const createConnectionInputSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(320),
  externalAccountId: z.string().trim().min(1).max(100).optional(),
  credentials: z.record(z.string().max(60), z.string().max(2_000)).default({}),
  settings: z
    .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 20)
    .default({}),
});

export const updateConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  /** Replaces the given credential fields; omitted fields keep their stored values. */
  credentials: z.record(z.string().max(60), z.string().max(2_000)).optional(),
  settings: z
    .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 20)
    .optional(),
});

export interface ConnectionSummary {
  id: string;
  channel: Channel;
  provider: string;
  providerLabel: string;
  name: string;
  address: string;
  externalAccountId: string | null;
  status: ChannelConnection['status'];
  /** Credential fields that have a stored value (values of secret fields are never returned). */
  configuredFields: string[];
  /** Values of non-secret credential fields (e.g. a webhook username or account SID). */
  publicCredentials: Record<string, string>;
  settings: Record<string, unknown>;
  lastError: string | null;
  lastInboundAt: string | null;
  createdAt: string;
}

function normalizeAddress(channel: Channel, raw: string, countryCode: string): string {
  switch (channel) {
    case 'email':
      return normalizeEmail(raw, 'address');
    case 'whatsapp':
      return normalizePhone(raw, countryCode, 'address');
    case 'sms':
      // E.164 number, alphanumeric sender id (3–11 chars) or a Messaging Service SID.
      if (/^MG[0-9a-f]{32}$/.test(raw)) return raw;
      if (/^[A-Za-z][A-Za-z0-9 ]{2,10}$/.test(raw)) return raw;
      return normalizePhone(raw, countryCode, 'address');
  }
}

function providerOrThrow(services: CommunicationsServices, key: string): ChannelProvider {
  const provider = services.providers.get(key);
  if (!provider)
    throw new ValidationError('Unknown provider', [{ path: 'provider', message: 'Not available' }]);
  return provider;
}

function decryptCredentials(
  services: CommunicationsServices,
  row: Pick<ChannelConnection, 'id' | 'organizationId' | 'credentialsCiphertext'>,
): Record<string, string> {
  if (!row.credentialsCiphertext) return {};
  if (!services.secretBox) throw new ConflictError('Credential encryption is not configured');
  const parsed = JSON.parse(
    services.secretBox.decrypt(
      row.credentialsCiphertext,
      associatedData(row.organizationId, row.id),
    ),
  ) as unknown;
  return z.record(z.string(), z.string()).parse(parsed);
}

function sealCredentials(
  services: CommunicationsServices,
  organizationId: string,
  connectionId: string,
  credentials: Record<string, string>,
): string {
  if (!services.secretBox) {
    throw new ConflictError('Credential storage is not configured (CREDENTIALS_ENCRYPTION_KEYS)');
  }
  return services.secretBox.encrypt(
    JSON.stringify(credentials),
    associatedData(organizationId, connectionId),
  );
}

/** Validates a complete credential set for the provider (empty means "configure later"). */
function validateCredentials(
  provider: ChannelProvider,
  credentials: Record<string, string>,
): Record<string, string> {
  const result = provider.credentialsSchema.safeParse(credentials);
  if (!result.success) {
    throw new ValidationError(
      'Invalid credentials',
      result.error.issues.map((issue) => ({
        path: `credentials.${issue.path.map(String).join('.')}`,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function toConnectionSummary(
  services: CommunicationsServices,
  row: ChannelConnection,
): ConnectionSummary {
  const provider = services.providers.get(row.provider);
  let stored: Record<string, string> = {};
  try {
    stored = decryptCredentials(services, row);
  } catch {
    stored = {};
  }
  const fields = provider?.credentialFields ?? [];
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    name: row.name,
    address: row.address,
    externalAccountId: row.externalAccountId,
    status: row.status,
    configuredFields: fields
      .filter((field) => Boolean(stored[field.key]))
      .map((field) => field.key),
    publicCredentials: Object.fromEntries(
      fields
        .filter((field) => !field.secret && stored[field.key])
        .map((field) => [field.key, stored[field.key] ?? '']),
    ),
    settings: row.settings,
    lastError: row.lastError,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function translateConflict(error: unknown): never {
  if (isUniqueViolation(error, 'channel_connections_provider_account_unique')) {
    throw new ConflictError('This provider account is already connected', {
      details: [
        {
          path: 'externalAccountId',
          message: 'Already connected (here or in another organization)',
        },
      ],
    });
  }
  throw error;
}

export async function createConnection(
  tx: TenantTx,
  ctx: CrmContext,
  services: CommunicationsServices,
  rawInput: z.input<typeof createConnectionInputSchema>,
): Promise<{ connection: ConnectionSummary; webhookUrl: string }> {
  const input = createConnectionInputSchema.parse(rawInput);
  const provider = providerOrThrow(services, input.provider);
  if (provider.requiresExternalAccountId && !input.externalAccountId) {
    throw new ValidationError('Missing account id', [
      { path: 'externalAccountId', message: 'Required for this provider' },
    ]);
  }
  const id = newId();
  const token = randomBytes(32).toString('base64url');
  let credentials = { ...input.credentials };
  if (provider.key.startsWith('fake_') && !credentials.webhookSecret) {
    credentials.webhookSecret = randomBytes(24).toString('base64url');
  }
  const configured = Object.keys(credentials).length > 0;
  if (configured) credentials = validateCredentials(provider, credentials);
  const sealed =
    configured || services.secretBox
      ? sealCredentials(services, ctx.organizationId, id, {
          ...credentials,
          [WEBHOOK_TOKEN_KEY]: token,
        })
      : null;
  let row: ChannelConnection | undefined;
  try {
    [row] = await tx
      .insert(channelConnections)
      .values({
        id,
        organizationId: ctx.organizationId,
        channel: provider.channel,
        provider: provider.key,
        name: input.name,
        status: configured ? 'active' : 'configuration_required',
        address: normalizeAddress(provider.channel, input.address, ctx.countryCode),
        externalAccountId: input.externalAccountId ?? null,
        webhookTokenHash: hashWebhookToken(token),
        credentialsCiphertext: sealed,
        settings: input.settings,
        createdByUserId: ctx.actor.userId,
      })
      .returning();
  } catch (error) {
    translateConflict(error);
  }
  if (!row) throw new Error('connection insert returned no row');
  return {
    connection: toConnectionSummary(services, row),
    webhookUrl: webhookUrl(services, provider.key, token),
  };
}

async function lockConnection(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<ChannelConnection> {
  const [row] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(eq(channelConnections.id, id), eq(channelConnections.organizationId, organizationId)),
    )
    .for('update');
  if (!row) throw new NotFoundError('Channel');
  return row;
}

export async function listConnections(
  tx: TenantTx,
  organizationId: string,
  services: CommunicationsServices,
  options: { includeDisconnected?: boolean } = {},
): Promise<ConnectionSummary[]> {
  const conditions = [eq(channelConnections.organizationId, organizationId)];
  if (!options.includeDisconnected) conditions.push(ne(channelConnections.status, 'disconnected'));
  const rows = await tx
    .select()
    .from(channelConnections)
    .where(and(...conditions))
    .orderBy(asc(channelConnections.channel), asc(channelConnections.createdAt))
    .limit(100);
  return rows.map((row) => toConnectionSummary(services, row));
}

export async function getConnectionRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<ChannelConnection> {
  const [row] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(eq(channelConnections.id, id), eq(channelConnections.organizationId, organizationId)),
    );
  if (!row) throw new NotFoundError('Channel');
  return row;
}

export async function updateConnection(
  tx: TenantTx,
  organizationId: string,
  services: CommunicationsServices,
  id: string,
  rawInput: z.input<typeof updateConnectionInputSchema>,
): Promise<ConnectionSummary> {
  const input = updateConnectionInputSchema.parse(rawInput);
  const row = await lockConnection(tx, organizationId, id);
  if (row.status === 'disconnected') throw new ConflictError('This channel is disconnected');
  const provider = providerOrThrow(services, row.provider);
  const set: Partial<typeof channelConnections.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.settings !== undefined) set.settings = input.settings;
  if (input.credentials !== undefined) {
    const current = decryptCredentials(services, row);
    const token = current[WEBHOOK_TOKEN_KEY];
    const { [WEBHOOK_TOKEN_KEY]: _token, ...existing } = current;
    const merged = validateCredentials(provider, { ...existing, ...input.credentials });
    set.credentialsCiphertext = sealCredentials(services, organizationId, id, {
      ...merged,
      ...(token ? { [WEBHOOK_TOKEN_KEY]: token } : {}),
    });
    set.status = 'active';
    set.lastError = null;
  }
  const [updated] = await tx
    .update(channelConnections)
    .set(set)
    .where(
      and(eq(channelConnections.id, id), eq(channelConnections.organizationId, organizationId)),
    )
    .returning();
  if (!updated) throw new NotFoundError('Channel');
  return toConnectionSummary(services, updated);
}

/** Issues a new webhook URL; the old one stops working immediately. */
export async function rotateWebhookToken(
  tx: TenantTx,
  organizationId: string,
  services: CommunicationsServices,
  id: string,
): Promise<{ webhookUrl: string }> {
  const row = await lockConnection(tx, organizationId, id);
  if (row.status === 'disconnected') throw new ConflictError('This channel is disconnected');
  const token = randomBytes(32).toString('base64url');
  const current = row.credentialsCiphertext ? decryptCredentials(services, row) : {};
  await tx
    .update(channelConnections)
    .set({
      webhookTokenHash: hashWebhookToken(token),
      ...(services.secretBox
        ? {
            credentialsCiphertext: sealCredentials(services, organizationId, id, {
              ...current,
              [WEBHOOK_TOKEN_KEY]: token,
            }),
          }
        : {}),
    })
    .where(eq(channelConnections.id, id));
  return { webhookUrl: webhookUrl(services, row.provider, token) };
}

/** Disconnects a channel and destroys its stored credentials. History is kept. */
export async function disconnectConnection(
  tx: TenantTx,
  organizationId: string,
  services: CommunicationsServices,
  id: string,
): Promise<ConnectionSummary> {
  await lockConnection(tx, organizationId, id);
  const [updated] = await tx
    .update(channelConnections)
    .set({
      status: 'disconnected',
      credentialsCiphertext: null,
      webhookTokenHash: hashWebhookToken(randomBytes(32).toString('base64url')),
    })
    .where(
      and(eq(channelConnections.id, id), eq(channelConnections.organizationId, organizationId)),
    )
    .returning();
  if (!updated) throw new NotFoundError('Channel');
  return toConnectionSummary(services, updated);
}

/** Decrypted view for adapters (worker and webhook handling only; never serialized). */
export function resolveConnection(
  services: CommunicationsServices,
  row: ChannelConnection,
): ResolvedConnection {
  const credentials = decryptCredentials(services, row);
  const token = credentials[WEBHOOK_TOKEN_KEY];
  const { [WEBHOOK_TOKEN_KEY]: _token, ...providerCredentials } = credentials;
  return {
    id: row.id,
    organizationId: row.organizationId,
    channel: row.channel,
    address: row.address,
    externalAccountId: row.externalAccountId,
    credentials: providerCredentials,
    settings: row.settings,
    webhookUrl: token ? webhookUrl(services, row.provider, token) : null,
  };
}

/**
 * Routes an inbound webhook to its connection by the token in the URL. System scope is required:
 * the tenant is not known until the connection is found (documented system-scope use).
 */
export async function findConnectionByWebhookToken(
  db: Database,
  provider: string,
  token: string,
): Promise<ChannelConnection | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await withSystem(db, (tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.webhookTokenHash, hashWebhookToken(token)),
          eq(channelConnections.provider, provider),
          ne(channelConnections.status, 'disconnected'),
        ),
      ),
  );
  return row ?? null;
}
