/**
 * Validates a post-login redirect target. Only same-site relative paths are allowed, which
 * prevents open redirects (`//evil.com`, `https://evil.com`, `/\evil.com`).
 */
export function safeNextPath(value: string | string[] | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  // Reject control characters (e.g. header injection or `\t//evil.com` tricks).
  for (const char of value) {
    if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) return null;
  }
  return value;
}

export function pickString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
