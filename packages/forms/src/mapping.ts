import type { CustomFieldSet } from '@businessos/crm';
import type { CrmCustomField, FormField, FormFieldType } from '@businessos/database';
import type { ErrorDetail } from '@businessos/shared';

/**
 * CRM mapping allow-list. A form field may feed one of these contact properties or a contact
 * custom field (`contact.custom.<key>`) — nothing else. Ownership, lifecycle stage, status,
 * source, tags and organization are never mappable: they come from the form's settings (or are
 * fixed), so a submitter cannot set them (no mass assignment).
 */
export const STANDARD_TARGETS = {
  'contact.fullName': ['text', 'hidden'],
  'contact.firstName': ['text', 'hidden'],
  'contact.lastName': ['text', 'hidden'],
  'contact.email': ['email'],
  'contact.phone': ['phone'],
  'contact.whatsappPhone': ['phone'],
  'contact.jobTitle': ['text', 'hidden'],
} as const satisfies Record<string, readonly FormFieldType[]>;
export type StandardTarget = keyof typeof STANDARD_TARGETS;

export const CUSTOM_TARGET_PREFIX = 'contact.custom.';

/** Custom field types each form field type can feed. */
const CUSTOM_COMPATIBILITY: Record<FormFieldType, readonly CrmCustomField['type'][]> = {
  text: ['text', 'textarea'],
  hidden: ['text', 'textarea'],
  textarea: ['textarea'],
  email: ['email', 'text'],
  phone: ['phone', 'text'],
  number: ['decimal', 'integer', 'text'],
  date: ['date', 'text'],
  select: ['select', 'text'],
  radio: ['select', 'text'],
  multi_select: ['multi_select'],
  checkbox: ['boolean'],
  consent: ['boolean'],
};

/** Form field types that can feed a custom field of `type` (for the builder's target picker). */
export function fieldTypesForCustomField(type: CrmCustomField['type']): FormFieldType[] {
  return (Object.keys(CUSTOM_COMPATIBILITY) as FormFieldType[]).filter((fieldType) =>
    CUSTOM_COMPATIBILITY[fieldType].includes(type),
  );
}

function isStandardTarget(target: string): target is StandardTarget {
  return Object.hasOwn(STANDARD_TARGETS, target);
}

interface MappableField {
  key: string;
  type: FormFieldType;
  options: { value: string; label: string }[];
  target?: string | null | undefined;
}

/**
 * Checks every field's target against the allow-list, the field type and the organization's
 * contact custom fields. Returns problems with `fields.<index>.target` paths.
 */
export function mappingProblems(
  fields: readonly MappableField[],
  customFields: CustomFieldSet,
): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const used = new Set<string>();
  fields.forEach((field, index) => {
    const target = field.target;
    if (!target) return;
    const path = `fields.${index}.target`;
    if (used.has(target)) {
      problems.push({ path, message: 'Another field already fills this property' });
      return;
    }
    used.add(target);
    if (isStandardTarget(target)) {
      if (!(STANDARD_TARGETS[target] as readonly FormFieldType[]).includes(field.type)) {
        problems.push({ path, message: 'This field type cannot fill this property' });
      }
      return;
    }
    if (!target.startsWith(CUSTOM_TARGET_PREFIX)) {
      problems.push({ path, message: 'Unknown CRM property' });
      return;
    }
    const custom = customFields.byKey.get(target.slice(CUSTOM_TARGET_PREFIX.length));
    if (custom?.archivedAt !== null) {
      problems.push({ path, message: 'Unknown custom field' });
      return;
    }
    if (!CUSTOM_COMPATIBILITY[field.type].includes(custom.type)) {
      problems.push({ path, message: 'This field type cannot fill this custom field' });
      return;
    }
    if (custom.type === 'select' || custom.type === 'multi_select') {
      const allowed = new Set(custom.options.map((option) => option.value));
      if (!field.options.every((option) => allowed.has(option.value))) {
        problems.push({ path, message: 'Every option must exist on the custom field' });
      }
    }
  });
  if (
    used.has('contact.fullName') &&
    (used.has('contact.firstName') || used.has('contact.lastName'))
  ) {
    const index = fields.findIndex((field) => field.target === 'contact.fullName');
    problems.push({
      path: `fields.${index}.target`,
      message: 'Map a full name or first and last names, not both',
    });
  }
  return problems;
}

export interface MappedContact {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  whatsappPhone?: string;
  jobTitle?: string;
  /** Custom field values keyed by custom field key. */
  customFields: Record<string, unknown>;
}

/** Turns validated answers into contact properties following each field's target. */
export function mapAnswers(
  fields: readonly FormField[],
  answers: Record<string, unknown>,
): MappedContact {
  const mapped: MappedContact = { customFields: {} };
  for (const field of fields) {
    const target = field.target;
    if (!target || !Object.hasOwn(answers, field.key)) continue;
    const value = answers[field.key];
    if (target.startsWith(CUSTOM_TARGET_PREFIX)) {
      mapped.customFields[target.slice(CUSTOM_TARGET_PREFIX.length)] = value;
      continue;
    }
    if (typeof value !== 'string' || !isStandardTarget(target)) continue;
    switch (target) {
      case 'contact.fullName': {
        const [first, ...rest] = value.split(/\s+/).filter(Boolean);
        if (first) mapped.firstName = first.slice(0, 100);
        if (rest.length > 0) mapped.lastName = rest.join(' ').slice(0, 100);
        break;
      }
      case 'contact.firstName':
        mapped.firstName = value.slice(0, 100);
        break;
      case 'contact.lastName':
        mapped.lastName = value.slice(0, 100);
        break;
      case 'contact.email':
        mapped.email = value;
        break;
      case 'contact.phone':
        mapped.phone = value;
        break;
      case 'contact.whatsappPhone':
        mapped.whatsappPhone = value;
        break;
      case 'contact.jobTitle':
        mapped.jobTitle = value.slice(0, 150);
        break;
    }
  }
  return mapped;
}

export function hasIdentity(contact: MappedContact): boolean {
  return Boolean(
    contact.email ??
    contact.phone ??
    contact.whatsappPhone ??
    contact.firstName ??
    contact.lastName,
  );
}
