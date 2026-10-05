import {
  appointmentTypes,
  bookingPages,
  bookingPageTypes,
  organizations,
  pgErrorInfo,
  PG_ERROR,
  withSystem,
  withTenant,
  type BookingPage,
  type Database,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  listAppointmentTypes,
  randomSlugSuffix,
  slugify,
  type AppointmentTypeSummary,
} from './appointment-types';

const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/, 'Use 3–64 lower-case letters, digits and dashes');

export const createBookingPageInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  slug: pageSlugSchema.optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  appointmentTypeIds: z.array(z.uuid()).min(1).max(20),
  isActive: z.boolean().default(true),
});

export const updateBookingPageInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: pageSlugSchema,
    description: z.string().trim().max(2_000).nullable(),
    appointmentTypeIds: z.array(z.uuid()).min(1).max(20),
    isActive: z.boolean(),
  })
  .partial();

export interface BookingPageSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  isActive: boolean;
  appointmentTypes: { id: string; name: string; isActive: boolean }[];
}

async function typesFor(tx: TenantTx, pageIds: readonly string[]) {
  const map = new Map<string, { id: string; name: string; isActive: boolean }[]>();
  if (pageIds.length === 0) return map;
  const rows = await tx
    .select({
      pageId: bookingPageTypes.bookingPageId,
      id: appointmentTypes.id,
      name: appointmentTypes.name,
      isActive: appointmentTypes.isActive,
    })
    .from(bookingPageTypes)
    .innerJoin(appointmentTypes, eq(appointmentTypes.id, bookingPageTypes.appointmentTypeId))
    .where(inArray(bookingPageTypes.bookingPageId, [...pageIds]))
    .orderBy(asc(bookingPageTypes.position), asc(appointmentTypes.name));
  for (const row of rows) {
    map.set(row.pageId, [
      ...(map.get(row.pageId) ?? []),
      { id: row.id, name: row.name, isActive: row.isActive },
    ]);
  }
  return map;
}

function toSummary(
  row: BookingPage,
  types: { id: string; name: string; isActive: boolean }[],
): BookingPageSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    isActive: row.isActive,
    appointmentTypes: types,
  };
}

async function assertTypes(tx: TenantTx, organizationId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await tx
    .select({ id: appointmentTypes.id })
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.organizationId, organizationId),
        inArray(appointmentTypes.id, unique),
      ),
    );
  if (rows.length !== unique.length) {
    throw new ValidationError('Invalid appointment types', [
      { path: 'appointmentTypeIds', message: 'Unknown appointment type' },
    ]);
  }
  return unique;
}

/**
 * Booking page slugs are global (the public URL carries no organization), so a taken slug gets
 * a random suffix instead of revealing which organization owns it.
 */
async function availableSlug(wanted: string, isTaken: (slug: string) => Promise<boolean>) {
  const base = (wanted.length >= 3 ? wanted : `${wanted}-book`).slice(0, 56).replace(/-+$/, '');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomSlugSuffix()}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new ConflictError('Could not reserve a booking link; try another name');
}

export async function listBookingPages(
  tx: TenantTx,
  organizationId: string,
): Promise<BookingPageSummary[]> {
  const rows = await tx
    .select()
    .from(bookingPages)
    .where(eq(bookingPages.organizationId, organizationId))
    .orderBy(asc(bookingPages.title), asc(bookingPages.id))
    .limit(200);
  const types = await typesFor(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toSummary(row, types.get(row.id) ?? []));
}

export async function getBookingPage(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<BookingPageSummary> {
  const [row] = await tx
    .select()
    .from(bookingPages)
    .where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Booking page');
  return toSummary(row, (await typesFor(tx, [id])).get(id) ?? []);
}

/** System scope: global slug uniqueness spans tenants (only existence is checked). */
function slugTaken(db: Database, excludeId?: string) {
  return async (slug: string) => {
    const [row] = await withSystem(db, (tx) =>
      tx.select({ id: bookingPages.id }).from(bookingPages).where(eq(bookingPages.slug, slug)),
    );
    return row !== undefined && row.id !== excludeId;
  };
}

async function replaceTypes(
  tx: TenantTx,
  organizationId: string,
  pageId: string,
  typeIds: readonly string[],
) {
  await tx.delete(bookingPageTypes).where(eq(bookingPageTypes.bookingPageId, pageId));
  await tx.insert(bookingPageTypes).values(
    typeIds.map((appointmentTypeId, position) => ({
      organizationId,
      bookingPageId: pageId,
      appointmentTypeId,
      position,
    })),
  );
}

export async function createBookingPage(
  db: Database,
  tx: TenantTx,
  organizationId: string,
  rawInput: z.input<typeof createBookingPageInputSchema>,
): Promise<BookingPageSummary> {
  const { appointmentTypeIds, slug, ...input } = createBookingPageInputSchema.parse(rawInput);
  const typeIds = await assertTypes(tx, organizationId, appointmentTypeIds);
  const reserved = await availableSlug(slug ?? slugify(input.title, 56), slugTaken(db));
  const [row] = await tx
    .insert(bookingPages)
    .values({ ...input, organizationId, slug: reserved })
    .returning();
  if (!row) throw new Error('booking page insert returned no row');
  await replaceTypes(tx, organizationId, row.id, typeIds);
  return getBookingPage(tx, organizationId, row.id);
}

export async function updateBookingPage(
  db: Database,
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updateBookingPageInputSchema>,
): Promise<BookingPageSummary> {
  const { appointmentTypeIds, slug, ...input } = updateBookingPageInputSchema.parse(rawInput);
  const current = await getBookingPage(tx, organizationId, id);
  const set: Partial<typeof bookingPages.$inferInsert> = { ...input };
  if (slug !== undefined && slug !== current.slug) {
    if (await slugTaken(db, id)(slug)) {
      throw new ConflictError('This booking link is taken', {
        details: [{ path: 'slug', message: 'Choose another link' }],
      });
    }
    set.slug = slug;
  }
  if (Object.keys(set).length > 0) {
    await tx
      .update(bookingPages)
      .set(set)
      .where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, organizationId)));
  }
  if (appointmentTypeIds !== undefined) {
    await replaceTypes(
      tx,
      organizationId,
      id,
      await assertTypes(tx, organizationId, appointmentTypeIds),
    );
  }
  return getBookingPage(tx, organizationId, id);
}

/** Deletes an unused page; pages that already have bookings can only be deactivated. */
export async function deleteBookingPage(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<BookingPageSummary> {
  const page = await getBookingPage(tx, organizationId, id);
  try {
    await tx.transaction(async (sp) => {
      await sp
        .delete(bookingPages)
        .where(and(eq(bookingPages.id, id), eq(bookingPages.organizationId, organizationId)));
    });
  } catch (error) {
    if (pgErrorInfo(error)?.code === PG_ERROR.foreignKeyViolation) {
      throw new ConflictError('This page has bookings; deactivate it instead');
    }
    throw error;
  }
  return page;
}

export interface PublicBookingPage {
  organizationId: string;
  organization: { name: string; timezone: string; countryCode: string; defaultCurrency: string };
  page: { id: string; slug: string; title: string; description: string | null };
  appointmentTypes: Pick<
    AppointmentTypeSummary,
    'id' | 'name' | 'slug' | 'description' | 'durationMinutes' | 'locationKind' | 'schedulingMode'
  >[];
}

/**
 * Resolves an active public booking page by slug. The slug lookup runs in system scope (the
 * request carries no tenant); everything after it runs inside the page's tenant.
 */
export async function resolvePublicBookingPage(
  db: Database,
  slug: string,
): Promise<PublicBookingPage | null> {
  if (!pageSlugSchema.safeParse(slug).success) return null;
  const [found] = await withSystem(db, (tx) =>
    tx
      .select({ id: bookingPages.id, organizationId: bookingPages.organizationId })
      .from(bookingPages)
      .innerJoin(organizations, eq(organizations.id, bookingPages.organizationId))
      .where(and(eq(bookingPages.slug, slug), eq(bookingPages.isActive, true))),
  );
  if (!found) return null;
  return withTenant(db, { organizationId: found.organizationId, userId: null }, async (tx) => {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, found.organizationId));
    if (!organization || organization.deletedAt) return null;
    const page = await getBookingPage(tx, found.organizationId, found.id);
    const active = new Set(page.appointmentTypes.filter((type) => type.isActive).map((t) => t.id));
    const types = (await listAppointmentTypes(tx, found.organizationId, { activeOnly: true }))
      .filter((type) => active.has(type.id))
      .sort(
        (a, b) =>
          page.appointmentTypes.findIndex((type) => type.id === a.id) -
          page.appointmentTypes.findIndex((type) => type.id === b.id),
      );
    return {
      organizationId: found.organizationId,
      organization: {
        name: organization.name,
        timezone: organization.timezone,
        countryCode: organization.countryCode,
        defaultCurrency: organization.defaultCurrency,
      },
      page: { id: page.id, slug: page.slug, title: page.title, description: page.description },
      appointmentTypes: types.map((type) => ({
        id: type.id,
        name: type.name,
        slug: type.slug,
        description: type.description,
        durationMinutes: type.durationMinutes,
        locationKind: type.locationKind,
        schedulingMode: type.schedulingMode,
      })),
    };
  });
}
