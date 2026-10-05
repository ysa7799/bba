/**
 * Allowed upload types, identified from the file's bytes (never from the client's declared
 * type). Formats that can carry script when opened by a browser (HTML, SVG, XML) are refused.
 */
export const ALLOWED_TYPES = {
  'image/png': { extensions: ['png'], inline: true },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], inline: true },
  'image/gif': { extensions: ['gif'], inline: true },
  'image/webp': { extensions: ['webp'], inline: true },
  'application/pdf': { extensions: ['pdf'], inline: false },
  'text/plain': { extensions: ['txt'], inline: false },
  'text/csv': { extensions: ['csv'], inline: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['docx'],
    inline: false,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['xlsx'],
    inline: false,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extensions: ['pptx'],
    inline: false,
  },
} as const;

export type AllowedType = keyof typeof ALLOWED_TYPES;

function startsWith(body: Buffer, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => body[offset + index] === byte);
}

const ascii = (text: string) => Array.from(Buffer.from(text, 'latin1'));

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

function isUtf8Text(body: Buffer): boolean {
  if (body.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/** The file's real type when it is allowed, otherwise null. */
export function sniffType(body: Buffer, name: string): AllowedType | null {
  const extension = extensionOf(name);
  if (startsWith(body, [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(body, ascii('GIF87a')) || startsWith(body, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(body, ascii('RIFF')) && startsWith(body, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(body, ascii('%PDF-'))) return 'application/pdf';
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML documents are ZIP containers; the extension says which one.
    const office = (Object.keys(ALLOWED_TYPES) as AllowedType[]).find(
      (type) =>
        type.startsWith('application/vnd.openxmlformats') &&
        (ALLOWED_TYPES[type].extensions as readonly string[]).includes(extension),
    );
    return office ?? null;
  }
  if ((extension === 'txt' || extension === 'csv') && isUtf8Text(body)) {
    const head = body.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    // Markup saved as .txt would still be markup; refuse it outright.
    if (head.startsWith('<')) return null;
    return extension === 'csv' ? 'text/csv' : 'text/plain';
  }
  return null;
}

/** Bidirectional controls can make `invoice<RLO>fdp.exe` display as `invoiceexe.pdf`. */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const MAX_NAME = 200;

function truncateKeepingExtension(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const extension = extensionOf(name);
  const keep = extension ? MAX_NAME - 1 - extension.length : MAX_NAME;
  return extension ? `${name.slice(0, keep)}.${extension}` : name.slice(0, MAX_NAME);
}

/**
 * A safe display name: no directories, no control, bidirectional-override or quote
 * characters, at most 200 characters (the extension is kept).
 */
export function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && char !== '"' && !BIDI_CONTROLS.test(char);
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned === '') return 'file';
  return truncateKeepingExtension(cleaned);
}

/**
 * The name with an extension that matches the detected type, so a download is always saved
 * as what it really is (a PNG named `page.html` becomes `page.html.png`, never an HTML file).
 */
export function nameForType(name: string, type: AllowedType): string {
  const extensions: readonly string[] = ALLOWED_TYPES[type].extensions;
  if (extensions.includes(extensionOf(name))) return name;
  const suffix = `.${extensions[0] ?? 'bin'}`;
  return `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
}

export function isInlineType(contentType: string): boolean {
  return (
    Object.hasOwn(ALLOWED_TYPES, contentType) && ALLOWED_TYPES[contentType as AllowedType].inline
  );
}
