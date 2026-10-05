/** Custom field values that differ from the initial ones (unchanged keys are not sent). */
export function changedCustomFields(
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(value ?? null) !== JSON.stringify(initial[key] ?? null))
      changed[key] = value ?? null;
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}
