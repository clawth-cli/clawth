import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { deriveKey, cachedDeriveKey, generateSalt } from "./kdf.ts";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  salt: string; // base64
}

export function encrypt(
  plaintext: string,
  passphrase: string,
  aad: string,
): EncryptedPayload {
  const salt = generateSalt();
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    salt: salt.toString("base64"),
  };
}

export async function decrypt(
  payload: EncryptedPayload,
  passphrase: string,
  aad: string,
): Promise<string> {
  const salt = Buffer.from(payload.salt, "base64");
  const key = await cachedDeriveKey(passphrase, salt);
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
