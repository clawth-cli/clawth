import { describe, test, expect } from "bun:test";
import { encrypt, decrypt } from "../src/crypto/encryption.ts";
import { deriveKey, generateSalt, hashPassphrase, verifyPassphrase } from "../src/crypto/kdf.ts";
import { signJwt } from "../src/crypto/jwt.ts";

describe("KDF", () => {
  test("generateSalt returns 32-byte buffer", () => {
    const salt = generateSalt();
    expect(salt.length).toBe(32);
  });

  test("deriveKey produces consistent output", () => {
    const salt = generateSalt();
    const key1 = deriveKey("test-passphrase", salt);
    const key2 = deriveKey("test-passphrase", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  test("deriveKey produces different output for different passphrases", () => {
    const salt = generateSalt();
    const key1 = deriveKey("passphrase-1", salt);
    const key2 = deriveKey("passphrase-2", salt);
    expect(key1.equals(key2)).toBe(false);
  });

  test("hashPassphrase and verifyPassphrase roundtrip", () => {
    const { hash, salt } = hashPassphrase("my-passphrase");
    expect(verifyPassphrase("my-passphrase", hash, salt)).toBe(true);
    expect(verifyPassphrase("wrong-passphrase", hash, salt)).toBe(false);
  });
});

describe("Encryption", () => {
  test("encrypt and decrypt roundtrip", async () => {
    const passphrase = "test-passphrase";
    const plaintext = "super-secret-api-key-12345";
    const aad = "github";

    const encrypted = encrypt(plaintext, passphrase, aad);
    const decrypted = await decrypt(encrypted, passphrase, aad);

    expect(decrypted).toBe(plaintext);
  });

  test("decrypt fails with wrong passphrase", async () => {
    const encrypted = encrypt("secret", "correct-passphrase", "service");
    expect(decrypt(encrypted, "wrong-passphrase", "service")).rejects.toThrow();
  });

  test("decrypt fails with wrong AAD (prevents row-swapping)", async () => {
    const encrypted = encrypt("secret", "passphrase", "github");
    expect(decrypt(encrypted, "passphrase", "gitlab")).rejects.toThrow();
  });

  test("each encryption produces unique IV and salt", () => {
    const e1 = encrypt("secret", "pass", "svc");
    const e2 = encrypt("secret", "pass", "svc");
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.salt).not.toBe(e2.salt);
  });
});

describe("JWT", () => {
  test("signs HS256 JWT", () => {
    const token = signJwt(
      { sub: "1234", iss: "test", exp: Math.floor(Date.now() / 1000) + 3600 },
      "my-hmac-secret",
      "HS256",
    );

    const parts = token.split(".");
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");

    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(payload.sub).toBe("1234");
    expect(payload.iss).toBe("test");
    expect(payload.iat).toBeGreaterThan(0);
  });
});
