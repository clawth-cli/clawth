import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { daemonDeriveKey } from "../session/client.ts";

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = "sha512";

const SALT_LENGTH = 32;

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
}

export async function cachedDeriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const cached = await daemonDeriveKey(salt.toString("base64"));
  if (cached) return Buffer.from(cached, "base64");
  return deriveKey(passphrase, salt);
}

// Passphrase verification hash using scrypt (stored in db_meta)
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

export function hashPassphrase(passphrase: string): {
  hash: string;
  salt: string;
} {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
  });
  return {
    hash: hash.toString("base64"),
    salt: salt.toString("base64"),
  };
}

export function verifyPassphrase(
  passphrase: string,
  storedHash: string,
  storedSalt: string,
): boolean {
  const salt = Buffer.from(storedSalt, "base64");
  const expected = Buffer.from(storedHash, "base64");
  const actual = scryptSync(passphrase, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
  });
  return timingSafeEqual(expected, actual);
}
