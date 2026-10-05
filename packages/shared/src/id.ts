import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562) generator with a monotonic 12-bit counter in `rand_a`, so IDs created by
 * one process are strictly increasing even within the same millisecond.
 */

let lastTimestamp = -1;
let counter = 0;

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function newId(now: number = Date.now()): string {
  let timestamp = now;
  if (timestamp <= lastTimestamp) {
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted for this millisecond: borrow the next one.
      lastTimestamp += 1;
      counter = 0;
    }
    timestamp = lastTimestamp;
  } else {
    lastTimestamp = timestamp;
    counter = 0;
  }

  const bytes = randomBytes(16);
  // 48-bit big-endian Unix timestamp in milliseconds.
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  // Version 7 + 12-bit counter.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  // RFC 4122 variant.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i] ?? 0] ?? '00';
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Extracts the millisecond timestamp encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}
