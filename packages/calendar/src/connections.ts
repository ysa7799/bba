import { calendarConnections, type CalendarConnection, type TenantTx } from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError, type SecretBox } from '@businessos/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Interval } from './availability';
import { getCalendarRow } from './calendars';
import type { CalendarProvider, ResolvedCalendarConnection } from './providers/types';

export class CalendarProviderRegistry {
  private readonly providers = new Map<string, CalendarProvider>();

  constructor(providers: readonly CalendarProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: CalendarProvider): void {
    this.providers.set(provider.key, provider);
  }

  get(key: string): CalendarProvider | undefined {
    return this.providers.get(key);
  }

  list(): CalendarProvider[] {
    return [...this.providers.values()];
  }
}

export interface CalendarServices {
  providers: CalendarProviderRegistry;
  /** Seals connection credentials; null when CREDENTIALS_ENCRYPTION_KEYS is not configured. */
  secretBox: SecretBox | null;
  /** Upper bound for one provider busy-time lookup. */
  providerTimeoutMs?: number;
}

const associatedData = (organizationId: string, id: string) =>
  `calendar_connection:${organizationId}:${id}`;

export interface CalendarConnectionSummary {
  id: string;
  calendarId: string;
  provider: string;
  providerLabel: string;
  externalCalendarId: string;
  status: CalendarConnection['status'];
  checkConflicts: boolean;
  writeEvents: boolean;
  configuredFields: string[];
  lastSyncedAt: string | null;
  lastError: string | null;
}

function decrypt(services: CalendarServices, row: CalendarConnection): Record<string, string> {
  if (!row.credentialsCiphertext || !services.secretBox) return {};
  const parsed = JSON.parse(
    services.secretBox.decrypt(
      row.credentialsCiphertext,
      associatedData(row.organizationId, row.id),
    ),
  ) as unknown;
  return z.record(z.string(), z.string()).parse(parsed);
}

function toSummary(services: CalendarServices, row: CalendarConnection): CalendarConnectionSummary {
  const provider = services.providers.get(row.provider);
  let configured: string[] = [];
  try {
    configured = Object.keys(decrypt(services, row));
  } catch {
    configured = [];
  }
  return {
    id: row.id,
    calendarId: row.calendarId,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    externalCalendarId: row.externalCalendarId,
    status: row.status,
    checkConflicts: row.checkConflicts,
    writeEvents: row.writeEvents,
    configuredFields: configured,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

export const connectCalendarInputSchema = z.object({
  provider: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/),
  externalCalendarId: z.string().trim().min(1).max(320).default('primary'),
  credentials: z.record(z.string().max(60), z.string().max(4_000)).default({}),
  checkConflicts: z.boolean().default(true),
  writeEvents: z.boolean().default(true),
});

export async function listCalendarConnections(
  tx: TenantTx,
  organizationId: string,
  services: CalendarServices,
  calendarId: string,
): Promise<CalendarConnectionSummary[]> {
  const rows = await tx
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.organizationId, organizationId),
        eq(calendarConnections.calendarId, calendarId),
        ne(calendarConnections.status, 'disconnected'),
      ),
    )
    .limit(20);
  return rows.map((row) => toSummary(services, row));
}

/**
 * Links an external calendar. Without credentials (or without an encryption key) the
 * connection stays `configuration_required` and is ignored for availability.
 */
export async function connectCalendar(
  tx: TenantTx,
  organizationId: string,
  services: CalendarServices,
  calendarId: string,
  rawInput: z.input<typeof connectCalendarInputSchema>,
): Promise<CalendarConnectionSummary> {
  const input = connectCalendarInputSchema.parse(rawInput);
  const provider = services.providers.get(input.provider);
  if (!provider) {
    throw new ValidationError('Unknown provider', [{ path: 'provider', message: 'Not available' }]);
  }
  await getCalendarRow(tx, organizationId, calendarId);
  const missing = provider.credentialFields
    .filter((field) => !input.credentials[field.key])
    .map((field) => field.key);
  const unknown = Object.keys(input.credentials).filter(
    (key) => !provider.credentialFields.some((field) => field.key === key),
  );
  if (unknown.length > 0) {
    throw new ValidationError('Unknown credential fields', [
      { path: 'credentials', message: `Not used by this provider: ${unknown.join(', ')}` },
    ]);
  }
  const hasCredentials = Object.keys(input.credentials).length > 0;
  if (hasCredentials && !services.secretBox) {
    throw new ConflictError('Credential encryption is not configured on this server');
  }
  const [existing] = await tx
    .select({ id: calendarConnections.id })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.calendarId, calendarId),
        eq(calendarConnections.provider, input.provider),
        ne(calendarConnections.status, 'disconnected'),
      ),
    );
  if (existing) throw new ConflictError('This calendar is already connected to that provider');
  const [row] = await tx
    .insert(calendarConnections)
    .values({
      organizationId,
      calendarId,
      provider: input.provider,
      externalCalendarId: input.externalCalendarId,
      checkConflicts: input.checkConflicts,
      writeEvents: input.writeEvents,
      status: missing.length === 0 ? 'active' : 'configuration_required',
    })
    .returning();
  if (!row) throw new Error('calendar connection insert returned no row');
  if (hasCredentials && services.secretBox) {
    const sealed = services.secretBox.encrypt(
      JSON.stringify(input.credentials),
      associatedData(organizationId, row.id),
    );
    await tx
      .update(calendarConnections)
      .set({ credentialsCiphertext: sealed })
      .where(eq(calendarConnections.id, row.id));
    return toSummary(services, { ...row, credentialsCiphertext: sealed });
  }
  return toSummary(services, row);
}

export async function disconnectCalendar(
  tx: TenantTx,
  organizationId: string,
  services: CalendarServices,
  connectionId: string,
): Promise<CalendarConnectionSummary> {
  const [row] = await tx
    .update(calendarConnections)
    .set({ status: 'disconnected', credentialsCiphertext: null })
    .where(
      and(
        eq(calendarConnections.id, connectionId),
        eq(calendarConnections.organizationId, organizationId),
        ne(calendarConnections.status, 'disconnected'),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError('Calendar connection');
  return toSummary(services, row);
}

/** Active connections of the given calendars, decrypted for server-side provider calls. */
export async function resolveConnections(
  tx: TenantTx,
  organizationId: string,
  services: CalendarServices,
  calendarIds: readonly string[],
  purpose: 'conflicts' | 'events',
): Promise<ResolvedCalendarConnection[]> {
  if (calendarIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.organizationId, organizationId),
        inArray(calendarConnections.calendarId, [...calendarIds]),
        eq(calendarConnections.status, 'active'),
        purpose === 'conflicts'
          ? eq(calendarConnections.checkConflicts, true)
          : eq(calendarConnections.writeEvents, true),
      ),
    );
  return rows
    .filter((row) => services.providers.get(row.provider))
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      provider: row.provider,
      calendarId: row.calendarId,
      externalCalendarId: row.externalCalendarId,
      credentials: decrypt(services, row),
    }));
}

/**
 * Busy times from connected calendars, per calendar. A calendar whose provider cannot be
 * reached is reported as unavailable (`null`) — offering its time could double-book it.
 */
export async function externalBusyTimes(
  services: CalendarServices,
  connections: readonly ResolvedCalendarConnection[],
  range: Interval,
): Promise<Map<string, Interval[] | null>> {
  const result = new Map<string, Interval[] | null>();
  const timeoutMs = services.providerTimeoutMs ?? 5_000;
  await Promise.all(
    connections.map(async (connection) => {
      const provider = services.providers.get(connection.provider);
      if (!provider) return;
      try {
        const busy = await Promise.race([
          provider.busyTimes(connection, range),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs).unref(),
          ),
        ]);
        const current = result.get(connection.calendarId);
        if (current !== null) result.set(connection.calendarId, [...(current ?? []), ...busy]);
      } catch {
        result.set(connection.calendarId, null);
      }
    }),
  );
  return result;
}
