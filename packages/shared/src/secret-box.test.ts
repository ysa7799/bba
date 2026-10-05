import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InternalError } from './errors';
import { SecretBox } from './secret-box';

const key = (id: string) => ({ id, key: randomBytes(32) });

describe('SecretBox', () => {
  it('round-trips and produces a fresh IV every time', () => {
    const box = new SecretBox([key('k1')]);
    const a = box.encrypt('{"token":"abc"}', 'org:conn');
    const b = box.encrypt('{"token":"abc"}', 'org:conn');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.k1.')).toBe(true);
    expect(box.decrypt(a, 'org:conn')).toBe('{"token":"abc"}');
    expect(a).not.toContain('abc');
  });

  it('refuses ciphertext moved to other associated data, tampered or sealed with an unknown key', () => {
    const box = new SecretBox([key('k1')]);
    const sealed = box.encrypt('secret', 'orgA:conn1');
    expect(() => box.decrypt(sealed, 'orgB:conn1')).toThrow(InternalError);
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[4] ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    parts[4] = flipped.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'orgA:conn1')).toThrow(InternalError);
    expect(() => new SecretBox([key('other')]).decrypt(sealed, 'orgA:conn1')).toThrow(
      InternalError,
    );
    expect(() => box.decrypt('garbage', 'orgA:conn1')).toThrow(InternalError);
  });

  it('rotates: new key encrypts, old keys still decrypt', () => {
    const oldKey = key('old');
    const legacy = new SecretBox([oldKey]).encrypt('v', 'ad');
    const rotated = new SecretBox([key('new'), oldKey]);
    expect(rotated.decrypt(legacy, 'ad')).toBe('v');
    expect(SecretBox.keyIdOf(rotated.encrypt('v', 'ad'))).toBe('new');
  });

  it('parses configuration and validates key material', () => {
    const encoded = randomBytes(32).toString('base64');
    expect(() => SecretBox.fromConfig(`k1:${encoded}`)).not.toThrow();
    expect(() => SecretBox.fromConfig('k1:c2hvcnQ=')).toThrow(InternalError);
    expect(() => SecretBox.fromConfig('')).toThrow(InternalError);
    expect(() => SecretBox.fromConfig(`bad id!:${encoded}`)).toThrow(InternalError);
  });
});
