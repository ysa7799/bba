import {
  crmCustomFields,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  isUniqueViolation,
  type CrmCustomField,
  type CustomFieldEntity,
  type TenantTx,
} from '@businessos/database';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '@businessos/shared';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CrmContext } from './context';
import { assertActiveMember } from './members';
import { normalizeEmail, normalizePhone, normalizeUrl } from './normalize';

export const MAX_CUSTOM_FIELDS_PER_ENTITY = 100;

const optionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
});

const optionsSchema = z
  .array(optionSchema)
  .max(200)
  .refine((options) => new Set(options.map((option) => option.value)).size === options.length, {
    message: 'Option values must be unique',
  });

export const customFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, {
    message: 'Lowercase letters, digits and underscores; must start with a letter',
  });

const SELECT_TYPES = new Set(['select', 'multi_select']);

export const createCustomFieldInputSchema = z
  .object({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key: customFieldKeySchema,
    label: z.string().trim().min(1).max(100),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema.default([]),
    required: z.boolean().default(false),
    helpText: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (SELECT_TYPES.has(input.type) && input.options.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
    }
    if (!SELECT_TYPES.has(input.type) && input.options.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only select fields have options',
      });
    }
  });

/** Key, type and entity are immutable: stored values and integrations depend on them. */
export const updateCustomFieldInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    options: optionsSchema,
    required: z.boolean(),
    helpText: z.string().trim().max(500).nullable(),
    position: z.number().int().min(0).max(10_000),
    archived: z.boolean(),
  })
  .partial();

export interface CustomFieldDefinition {
  id: string;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CrmCustomField['type'];
  options: { value: string; label: string }[];
  required: boolean;
  helpText: string | null;
  position: number;
  archived: boolean;
}

export function toCustomFieldDefinition(field: CrmCustomField): CustomFieldDefinition {
  return {
    id: field.id,
    entityType: field.entityType,
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options,
    required: field.required,
    helpText: field.helpText,
    position: field.position,
    archived: field.archivedAt !== null,
  };
}

export async function listCustomFields(
  tx: TenantTx,
  organizationId: string,
  options: { entityType?: CustomFieldEntity | undefined; includeArchived?: boolean } = {},
): Promise<CustomFieldDefinition[]> {
  const conditions = [eq(crmCustomFields.organizationId, organizationId)];
  if (options.entityType) conditions.push(eq(crmCustomFields.entityType, options.entityType));
  if (!options.includeArchived) conditions.push(isNull(crmCustomFields.archivedAt));
  const rows = await tx
    .select()
    .from(crmCustomFields)
    .where(and(...conditions))
    .orderBy(
      asc(crmCustomFields.entityType),
      asc(crmCustomFields.position),
      asc(crmCustomFields.id),
    );
  return rows.map(toCustomFieldDefinition);
}

async function getField(tx: TenantTx, organizationId: string, id: string): Promise<CrmCustomField> {
  const [field] = await tx
    .select()
    .from(crmCustomFields)
    .where(and(eq(crmCustomFields.id, id), eq(crmCustomFields.organizationId, organizationId)));
  if (!field) throw new NotFoundError('Custom field');
  return field;
}

export async function createCustomField(
  tx: TenantTx,
  organizationId: string,
  rawInput: z.input<typeof createCustomFieldInputSchema>,
): Promise<CustomFieldDefinition> {
  const input = createCustomFieldInputSchema.parse(rawInput);
  // Serialize definitions per organization so the cap cannot be raced past.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`crm.custom_fields:${organizationId}`}, 0))`,
  );
  const [existing] = await tx
    .select({ n: count() })
    .from(crmCustomFields)
    .where(
      and(
        eq(crmCustomFields.organizationId, organizationId),
        eq(crmCustomFields.entityType, input.entityType),
      ),
    );
  const used = existing?.n ?? 0;
  if (used >= MAX_CUSTOM_FIELDS_PER_ENTITY) {
    throw new ConflictError(
      `At most ${MAX_CUSTOM_FIELDS_PER_ENTITY} custom fields per record type`,
    );
  }
  try {
    const [field] = await tx
      .insert(crmCustomFields)
      .values({
        organizationId,
        entityType: input.entityType,
        key: input.key,
        label: input.label,
        type: input.type,
        options: input.options,
        required: input.required,
        helpText: input.helpText ?? null,
        position: used,
      })
      .returning();
    if (!field) throw new Error('custom field insert returned no row');
    return toCustomFieldDefinition(field);
  } catch (error) {
    if (isUniqueViolation(error, 'crm_custom_fields_org_entity_key_unique')) {
      throw new ConflictError('A field with this key already exists', {
        details: [{ path: 'key', message: 'Already in use (including archived fields)' }],
      });
    }
    throw error;
  }
}

export async function updateCustomField(
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updateCustomFieldInputSchema>,
): Promise<{ before: CustomFieldDefinition; after: CustomFieldDefinition }> {
  const input = updateCustomFieldInputSchema.parse(rawInput);
  const field = await getField(tx, organizationId, id);
  if (input.options !== undefined) {
    if (!SELECT_TYPES.has(field.type) && input.options.length > 0) {
      throw new ValidationError('Invalid options', [
        { path: 'options', message: 'Only select fields have options' },
      ]);
    }
    if (SELECT_TYPES.has(field.type) && input.options.length === 0) {
      throw new ValidationError('Invalid options', [
        { path: 'options', message: 'Add at least one option' },
      ]);
    }
  }
  const { archived, ...rest } = input;
  const [updated] = await tx
    .update(crmCustomFields)
    .set({
      ...rest,
      ...(archived === undefined
        ? {}
        : { archivedAt: archived ? (field.archivedAt ?? new Date()) : null }),
    })
    .where(and(eq(crmCustomFields.id, id), eq(crmCustomFields.organizationId, organizationId)))
    .returning();
  if (!updated) throw new NotFoundError('Custom field');
  return { before: toCustomFieldDefinition(field), after: toCustomFieldDefinition(updated) };
}

/** Stored custom values are keyed by field id; the API speaks field keys. */
export type StoredCustomValues = Record<string, unknown>;
export type ApiCustomValues = Record<string, unknown>;

const DECIMAL = /^-?\d{1,18}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The custom field definitions of one record type, used to validate and present values. */
export class CustomFieldSet {
  readonly byKey: ReadonlyMap<string, CrmCustomField>;
  readonly byId: ReadonlyMap<string, CrmCustomField>;

  constructor(
    readonly entityType: CustomFieldEntity,
    fields: readonly CrmCustomField[],
  ) {
    this.byKey = new Map(fields.map((field) => [field.key, field]));
    this.byId = new Map(fields.map((field) => [field.id, field]));
  }

  static async load(
    tx: TenantTx,
    organizationId: string,
    entityType: CustomFieldEntity,
  ): Promise<CustomFieldSet> {
    const fields = await tx
      .select()
      .from(crmCustomFields)
      .where(
        and(
          eq(crmCustomFields.organizationId, organizationId),
          eq(crmCustomFields.entityType, entityType),
        ),
      )
      .orderBy(asc(crmCustomFields.position), asc(crmCustomFields.id));
    return new CustomFieldSet(entityType, fields);
  }

  /** Active (non-archived) fields in display order. */
  active(): CrmCustomField[] {
    return [...this.byId.values()].filter((field) => field.archivedAt === null);
  }

  /** API representation: values of active fields keyed by field key. */
  toApi(stored: StoredCustomValues): ApiCustomValues {
    const out: ApiCustomValues = {};
    for (const field of this.active()) {
      if (Object.hasOwn(stored, field.id)) out[field.key] = stored[field.id];
    }
    return out;
  }

  /**
   * Validates an API patch (`{ key: value | null }`) and merges it into the stored values.
   * Unknown and archived keys are rejected; `null` clears a value. On create, required fields
   * must end up with a value; on update a required value cannot be cleared.
   */
  async apply(
    tx: TenantTx,
    ctx: CrmContext,
    patch: ApiCustomValues | undefined,
    existing: StoredCustomValues | null,
  ): Promise<StoredCustomValues> {
    const next = new Map(Object.entries(existing ?? {}));
    const errors: ErrorDetail[] = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      const path = `customFields.${key}`;
      const field = this.byKey.get(key);
      if (field?.archivedAt !== null) {
        errors.push({ path, message: 'Unknown custom field' });
        continue;
      }
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        if (field.required) errors.push({ path, message: 'Required' });
        else next.delete(field.id);
        continue;
      }
      try {
        next.set(field.id, await this.normalizeValue(tx, ctx, field, value, path));
      } catch (error) {
        if (error instanceof ValidationError)
          errors.push(...(error.details ?? [{ path, message: error.message }]));
        else throw error;
      }
    }
    if (existing === null) {
      for (const field of this.active()) {
        if (field.required && !next.has(field.id)) {
          errors.push({ path: `customFields.${field.key}`, message: 'Required' });
        }
      }
    }
    if (errors.length > 0) throw new ValidationError('Invalid custom field values', errors);
    return Object.fromEntries(next);
  }

  private async normalizeValue(
    tx: TenantTx,
    ctx: CrmContext,
    field: CrmCustomField,
    value: unknown,
    path: string,
  ): Promise<unknown> {
    const invalid = (message: string): never => {
      throw new ValidationError(message, [{ path, message }]);
    };
    switch (field.type) {
      case 'text':
      case 'textarea': {
        const max = field.type === 'text' ? 500 : 10_000;
        if (typeof value !== 'string') return invalid('Must be text');
        const text = value.trim();
        if (text.length > max) return invalid(`At most ${max} characters`);
        return text;
      }
      case 'integer': {
        const number =
          typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim()) ? Number(value) : value;
        if (typeof number !== 'number' || !Number.isSafeInteger(number))
          return invalid('Must be a whole number');
        return number;
      }
      case 'decimal': {
        // Decimals are stored as strings: never through binary floating point.
        const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
        if (typeof text !== 'string' || !DECIMAL.test(text.trim()))
          return invalid('Must be a decimal number');
        return text.trim();
      }
      case 'boolean': {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 'false') return value === 'true';
        return invalid('Must be true or false');
      }
      case 'date': {
        if (typeof value !== 'string' || !isValidDate(value.trim()))
          return invalid('Must be a date (YYYY-MM-DD)');
        return value.trim();
      }
      case 'datetime': {
        if (
          typeof value !== 'string' ||
          !z.iso.datetime({ offset: true }).safeParse(value.trim()).success
        ) {
          return invalid('Must be an ISO 8601 date-time');
        }
        return new Date(value.trim()).toISOString();
      }
      case 'select': {
        if (typeof value !== 'string' || !field.options.some((option) => option.value === value)) {
          return invalid('Not one of the allowed options');
        }
        return value;
      }
      case 'multi_select': {
        if (!Array.isArray(value) || value.length > 50) return invalid('Must be a list of options');
        const allowed = new Set(field.options.map((option) => option.value));
        const unique = [...new Set(value)];
        if (
          !unique.every((item): item is string => typeof item === 'string' && allowed.has(item))
        ) {
          return invalid('Contains values that are not allowed options');
        }
        return unique;
      }
      case 'email':
        if (typeof value !== 'string') return invalid('Must be an email address');
        return normalizeEmail(value, path);
      case 'phone':
        if (typeof value !== 'string') return invalid('Must be a phone number');
        return normalizePhone(value, ctx.countryCode, path);
      case 'url':
        if (typeof value !== 'string') return invalid('Must be a URL');
        return normalizeUrl(value, path);
      case 'user': {
        if (typeof value !== 'string' || !z.uuid().safeParse(value).success)
          return invalid('Must be a user id');
        await assertActiveMember(tx, ctx.organizationId, value, path);
        return value;
      }
    }
  }

  /**
   * Equality filters from query parameters (`cf.<key>=value`) as a JSONB containment document
   * (served by the GIN index). Unknown keys are a client error.
   */
  filterDocument(filters: Record<string, string>): StoredCustomValues | null {
    const entries = Object.entries(filters);
    if (entries.length === 0) return null;
    if (entries.length > 10) {
      throw new ValidationError('Too many custom field filters', [
        { path: 'cf', message: 'At most 10' },
      ]);
    }
    const document: StoredCustomValues = {};
    for (const [key, raw] of entries) {
      const field = this.byKey.get(key);
      const path = `cf.${key}`;
      if (field?.archivedAt !== null) {
        throw new ValidationError('Unknown custom field', [
          { path, message: 'Unknown custom field' },
        ]);
      }
      switch (field.type) {
        case 'boolean':
          if (raw !== 'true' && raw !== 'false') {
            throw new ValidationError('Invalid filter', [
              { path, message: 'Must be true or false' },
            ]);
          }
          document[field.id] = raw === 'true';
          break;
        case 'integer':
          if (!/^-?\d{1,15}$/.test(raw)) {
            throw new ValidationError('Invalid filter', [
              { path, message: 'Must be a whole number' },
            ]);
          }
          document[field.id] = Number(raw);
          break;
        case 'multi_select':
          document[field.id] = [raw];
          break;
        default:
          document[field.id] = field.type === 'email' ? raw.trim().toLowerCase() : raw;
      }
    }
    return document;
  }
}
