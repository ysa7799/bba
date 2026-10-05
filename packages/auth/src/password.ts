import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import type { PasswordHashParams } from './config';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

// A short deny-list of the most common passwords that satisfy the length rule.
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '0123456789',
  'qwertyuiop',
  'password123',
  'password1234',
  'iloveyou123',
  'qwerty12345',
  'abcdefghij',
  'passw0rd123',
  'administrator',
  'letmein1234',
  'welcome123',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'aaaaaaaaaa',
]);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: 'This password is too common',
  })
  .refine((value) => new Set(value).size >= 4, {
    message: 'This password is too simple',
  });

/** `Algorithm.Argon2id` from @node-rs/argon2 (an ambient const enum we cannot import). */
const ARGON2ID = 2;

function argonOptions(params: PasswordHashParams) {
  return {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCostKib,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  };
}

export async function hashPassword(password: string, params: PasswordHashParams): Promise<string> {
  return hash(password, argonOptions(params));
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True when a stored hash was produced with weaker/different parameters than configured. */
export function needsRehash(passwordHash: string, params: PasswordHashParams): boolean {
  return !passwordHash.startsWith(
    `$argon2id$v=19$m=${params.memoryCostKib},t=${params.timeCost},p=${params.parallelism}$`,
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a fixed dummy hash so that "unknown email" and "wrong password" take the same
 * time, preventing account enumeration through response timing.
 */
export async function burnPasswordCheck(
  password: string,
  params: PasswordHashParams,
): Promise<void> {
  dummyHash ??= hashPassword('businessos-dummy-password-for-timing', params);
  await verifyPassword(await dummyHash, password);
}
