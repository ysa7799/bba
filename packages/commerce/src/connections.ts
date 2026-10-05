import type { CrmContext } from '@businessos/crm';
import {
  commercePaymentConnections,
  isUniqueViolation,
  type CommercePaymentConnection,
  type Database,
  type TenantTx,
  type Tx,
} from '@businessos/database';
import {
  TapPaymentProvider,
  type FakePaymentProvider,
  type PaymentProvider,
} from '@businessos/payments';
import {
  ConflictError,
  newId,
  NotFoundError,
  ValidationError,
  type SecretBox,
} from '@businessos/shared';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';

/**
 * A payment provider an organization can connect its own account for (customers pay the
 * organization directly). Adapters are created per connection from its sealed credentials.
 */
export interface CommerceProviderDefinition {
  name: string;
  label: string;
  /** Fields the owner enters; `secret` fields are never shown again. Empty: none needed. */
  credentialFields: readonly { key: string; label: string; secret: boolean }[];
  credentialsSchema: z.ZodType<Record<string, string>>;
  create(credentials: Record<string, string>): PaymentProvider;
}

export interface CommerceServices {
  db: Database;
  providers: ReadonlyMap<string, CommerceProviderDefinition>;
  /** Null when credential encryption is not configured (credentials cannot be stored). */
  secretBox: SecretBox | null;
  /** Public API URL (provider webhooks). */
  apiPublicUrl: string;
  /** Public web URL (customer pages). */
  appUrl: string;
  logger?: { error: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

const tapCredentialsSchema = z.object({
  secretKey: z
    .string()
    .trim()
    .regex(
      /^sk_(test|live)_[A-Za-z0-9]{8,200}$/,
      'A Tap secret key starts with sk_test_ or sk_live_',
    ),
});

/**
 * Providers organizations can connect. The fake provider (development and tests only) is a
 * single in-process instance; Tap is CONFIGURATION_REQUIRED until the owner enters a secret key.
 */
export function commerceProviders(options: {
  fake?: FakePaymentProvider | null;
  tap?: { baseUrl?: string; fetch?: typeof fetch };
}): Map<string, CommerceProviderDefinition> {
  const providers = new Map<string, CommerceProviderDefinition>();
  providers.set('tap', {
    name: 'tap',
    label: 'Tap Payments',
    credentialFields: [{ key: 'secretKey', label: 'Secret key', secret: true }],
    credentialsSchema: tapCredentialsSchema,
    create: (credentials) =>
      new TapPaymentProvider({
        secretKey: credentials.secretKey ?? null,
        ...(options.tap?.baseUrl ? { baseUrl: options.tap.baseUrl } : {}),
        ...(options.tap?.fetch ? { fetch: options.tap.fetch } : {}),
      }),
  });
  const fake = options.fake;
  if (fake) {
    providers.set('fake', {
      name: 'fake',
      label: 'Test payments (development)',
      credentialFields: [],
      credentialsSchema: z.object({}),
      create: () => fake,
    });
  }
  return providers;
}

export const createPaymentConnectionInputSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(100),
  credentials: z.record(z.string().max(60), z.string().max(2_000)).default({}),
});
export const updatePaymentConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  /** Replaces the stored credentials. */
  credentials: z.record(z.string().max(60), z.string().max(2_000)).optional(),
});

export interface PaymentConnectionView {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  status: CommercePaymentConnection['status'];
  /** Credential fields with a stored value (values are never returned). */
  configuredFields: string[];
  credentialFields: readonly { key: string; label: string; secret: boolean }[];
  /** Where the provider sends payment notifications (set automatically on each checkout). */
  webhookUrl: string;
  lastError: string | null;
  createdAt: string;
}

function associatedData(organizationId: string, connectionId: string): string {
  return `commerce_payment_connection:${organizationId}:${connectionId}`;
}

export function commerceWebhookUrl(services: CommerceServices, connectionId: string): string {
  return `${services.apiPublicUrl.replace(/\/$/, '')}/webhooks/commerce/${connectionId}`;
}

function definitionOrThrow(services: CommerceServices, name: string): CommerceProviderDefinition {
  const definition = services.providers.get(name);
  if (!definition) {
    throw new ValidationError('Unknown provider', [{ path: 'provider', message: 'Not available' }]);
  }
  return definition;
}

function decrypt(
  services: CommerceServices,
  row: CommercePaymentConnection,
): Record<string, string> {
  if (!row.credentialsCiphertext) return {};
  if (!services.secretBox) throw new ConflictError('Credential encryption is not configured');
  const plain = services.secretBox.decrypt(
    row.credentialsCiphertext,
    associatedData(row.organizationId, row.id),
  );
  return z.record(z.string(), z.string()).parse(JSON.parse(plain));
}

function seal(
  services: CommerceServices,
  organizationId: string,
  connectionId: string,
  credentials: Record<string, string>,
): string | null {
  if (Object.keys(credentials).length === 0) return null;
  if (!services.secretBox) {
    throw new ConflictError('Credential storage is not configured (CREDENTIALS_ENCRYPTION_KEYS)');
  }
  return services.secretBox.encrypt(
    JSON.stringify(credentials),
    associatedData(organizationId, connectionId),
  );
}

/** Empty credentials mean "configure later"; anything else must be a complete, valid set. */
function validate(
  definition: CommerceProviderDefinition,
  credentials: Record<string, string>,
): { credentials: Record<string, string>; complete: boolean } {
  if (Object.keys(credentials).length === 0) {
    return { credentials: {}, complete: definition.credentialFields.length === 0 };
  }
  const result = definition.credentialsSchema.safeParse(credentials);
  if (!result.success) {
    throw new ValidationError(
      'Invalid credentials',
      result.error.issues.map((issue) => ({
        path: `credentials.${issue.path.map(String).join('.')}`,
        message: issue.message,
      })),
    );
  }
  return { credentials: result.data, complete: true };
}

export function toConnectionView(
  services: CommerceServices,
  row: CommercePaymentConnection,
): PaymentConnectionView {
  const definition = services.providers.get(row.provider);
  let stored: Record<string, string> = {};
  try {
    stored = decrypt(services, row);
  } catch {
    stored = {};
  }
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: definition?.label ?? row.provider,
    name: row.name,
    status: row.status,
    configuredFields: Object.keys(stored).filter((key) => Boolean(stored[key])),
    credentialFields: definition?.credentialFields ?? [],
    webhookUrl: commerceWebhookUrl(services, row.id),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function listProviderOptions(services: CommerceServices): {
  name: string;
  label: string;
  credentialFields: CommerceProviderDefinition['credentialFields'];
}[] {
  return [...services.providers.values()].map((definition) => ({
    name: definition.name,
    label: definition.label,
    credentialFields: definition.credentialFields,
  }));
}

/** The organization's live (not disconnected) connection, if any. */
export async function getLiveConnectionRow(
  tx: Tx,
  organizationId: string,
): Promise<CommercePaymentConnection | null> {
  const [row] = await tx
    .select()
    .from(commercePaymentConnections)
    .where(
      and(
        eq(commercePaymentConnections.organizationId, organizationId),
        ne(commercePaymentConnections.status, 'disconnected'),
      ),
    );
  return row ?? null;
}

export async function getPaymentConnection(
  tx: TenantTx,
  ctx: CrmContext,
  services: CommerceServices,
): Promise<PaymentConnectionView | null> {
  const row = await getLiveConnectionRow(tx, ctx.organizationId);
  return row ? toConnectionView(services, row) : null;
}

async function getConnectionRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<CommercePaymentConnection> {
  const [row] = await tx
    .select()
    .from(commercePaymentConnections)
    .where(
      and(
        eq(commercePaymentConnections.id, id),
        eq(commercePaymentConnections.organizationId, organizationId),
      ),
    )
    .for('update');
  if (!row) throw new NotFoundError('Payment connection');
  return row;
}

export async function createPaymentConnection(
  tx: TenantTx,
  ctx: CrmContext,
  services: CommerceServices,
  rawInput: z.input<typeof createPaymentConnectionInputSchema>,
): Promise<PaymentConnectionView> {
  const input = createPaymentConnectionInputSchema.parse(rawInput);
  const definition = definitionOrThrow(services, input.provider);
  const { credentials, complete } = validate(definition, input.credentials);
  const id = newId();
  let row: CommercePaymentConnection | undefined;
  try {
    [row] = await tx
      .insert(commercePaymentConnections)
      .values({
        id,
        organizationId: ctx.organizationId,
        provider: definition.name,
        name: input.name,
        status: complete ? 'active' : 'configuration_required',
        credentialsCiphertext: seal(services, ctx.organizationId, id, credentials),
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error, 'commerce_connections_one_live')) {
      throw new ConflictError('Disconnect the current payment provider first');
    }
    throw error;
  }
  if (!row) throw new Error('connection insert returned no row');
  return toConnectionView(services, row);
}

export async function updatePaymentConnection(
  tx: TenantTx,
  ctx: CrmContext,
  services: CommerceServices,
  id: string,
  rawInput: z.input<typeof updatePaymentConnectionInputSchema>,
): Promise<PaymentConnectionView> {
  const input = updatePaymentConnectionInputSchema.parse(rawInput);
  const current = await getConnectionRow(tx, ctx.organizationId, id);
  if (current.status === 'disconnected')
    throw new ConflictError('This connection was disconnected');
  const definition = definitionOrThrow(services, current.provider);
  const set: Partial<typeof commercePaymentConnections.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.credentials !== undefined) {
    const { credentials, complete } = validate(definition, input.credentials);
    set.credentialsCiphertext = seal(services, ctx.organizationId, id, credentials);
    set.status = complete ? 'active' : 'configuration_required';
    set.lastError = null;
  }
  const [row] = await tx
    .update(commercePaymentConnections)
    .set(set)
    .where(
      and(
        eq(commercePaymentConnections.id, id),
        eq(commercePaymentConnections.organizationId, ctx.organizationId),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError('Payment connection');
  return toConnectionView(services, row);
}

/** Disconnects and erases the stored credentials. Late webhooks for it are no longer accepted. */
export async function disconnectPaymentConnection(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<void> {
  const current = await getConnectionRow(tx, ctx.organizationId, id);
  if (current.status === 'disconnected') return;
  await tx
    .update(commercePaymentConnections)
    .set({ status: 'disconnected', credentialsCiphertext: null, updatedAt: new Date() })
    .where(
      and(
        eq(commercePaymentConnections.id, id),
        eq(commercePaymentConnections.organizationId, ctx.organizationId),
      ),
    );
}

/**
 * The adapter for an active connection, built from its decrypted credentials; null when the
 * connection is not usable (not configured, disconnected, provider unavailable here).
 */
export function providerForConnection(
  services: CommerceServices,
  row: CommercePaymentConnection,
): PaymentProvider | null {
  if (row.status !== 'active') return null;
  const definition = services.providers.get(row.provider);
  if (!definition) return null;
  let credentials: Record<string, string>;
  try {
    credentials = decrypt(services, row);
  } catch {
    services.logger?.error(
      { connectionId: row.id },
      'payment connection credentials could not be decrypted',
    );
    return null;
  }
  const provider = definition.create(credentials);
  return provider.status() === 'ready' ? provider : null;
}
