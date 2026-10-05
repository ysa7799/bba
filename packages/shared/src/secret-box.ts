import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InternalError } from './errors';

/**
 * Authenticated encryption for secrets at rest (provider credentials, tokens): AES-256-GCM with
 * versioned keys. Every ciphertext is bound to an "associated data" string (e.g.
 * `<organizationId>:<connectionId>`), so a ciphertext copied to another row or tenant fails to
 * decrypt. Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts).
 *
 * Keys come from configuration as `keyId:base64key` pairs (32-byte keys); the first is used
 * for new encryptions, all listed keys can decrypt (rotation).
 */
export interface SecretKey {
  id: string;
  key: Buffer;
}

export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  private readonly active: SecretKey;

  constructor(keys: readonly SecretKey[]) {
    const first = keys[0];
    if (!first) throw new InternalError('SecretBox needs at least one key');
    for (const key of keys) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(key.id)) throw new InternalError('Invalid secret key id');
      if (key.key.length !== 32) throw new InternalError('Secret keys must be 32 bytes');
    }
    this.keys = new Map(keys.map((key) => [key.id, key.key]));
    this.active = first;
  }

  /** Parses `id:base64,id2:base64` (as used in environment variables). */
  static fromConfig(value: string): SecretBox {
    const keys = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [id, encoded] = entry.split(':');
        if (!id || !encoded) throw new InternalError('Malformed secret key configuration');
        return { id, key: Buffer.from(encoded, 'base64') };
      });
    return new SecretBox(keys);
  }

  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.active.key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.active.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Throws (without detail) when the ciphertext was tampered with, moved or the key is unknown. */
  decrypt(sealed: string, associatedData: string): string {
    const [version, keyId, iv, tag, ciphertext] = sealed.split('.');
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (version !== 'v1' || !key || !iv || !tag || ciphertext === undefined) {
      throw new InternalError('Unable to decrypt secret');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalError('Unable to decrypt secret');
    }
  }

  /** Key id a ciphertext was sealed with (for rotation sweeps). */
  static keyIdOf(sealed: string): string | null {
    const parts = sealed.split('.');
    return parts[0] === 'v1' ? (parts[1] ?? null) : null;
  }
}
