import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase, closeDatabase } from "../src/db/connection.ts";
import {
  setMeta,
  getMeta,
  createCredential,
  listCredentials,
  getCredentialByService,
  decryptCredentialValue,
  updateCredentialSecret,
  deleteCredential,
  setAgentId,
} from "../src/db/repository.ts";
import { hashPassphrase, verifyPassphrase } from "../src/crypto/kdf.ts";
import { passphraseHashKey, passphraseSaltKey } from "../src/cli/shared.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "clawth-test-"));
  process.env.CLAWTH_DATA_DIR = tempDir;
  setAgentId("default");
  await initializeDatabase(join(tempDir, "test.db"));
});

afterEach(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAWTH_DATA_DIR;
});

describe("db_meta", () => {
  test("set and get meta", async () => {
    await setMeta("version", "1");
    const val = await getMeta("version");
    expect(val).toBe("1");
  });

  test("update existing meta", async () => {
    await setMeta("version", "1");
    await setMeta("version", "2");
    const val = await getMeta("version");
    expect(val).toBe("2");
  });

  test("get missing meta returns null", async () => {
    const val = await getMeta("nonexistent");
    expect(val).toBeNull();
  });
});

describe("credentials", () => {
  const passphrase = "test-passphrase";

  test("create and list credential", async () => {
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "ghp_test123",
      passphrase,
      patterns: ["*.github.com"],
    });

    const list = await listCredentials();
    expect(list.length).toBe(1);
    expect(list[0]!.service).toBe("github");
    expect(list[0]!.type).toBe("bearer");
    expect(list[0]!.agentId).toBe("default");
    expect(list[0]!.patterns).toEqual(["*.github.com"]);
  });

  test("decrypt credential value", async () => {
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "ghp_test123",
      passphrase,
      patterns: [],
    });

    const decrypted = await decryptCredentialValue("github", passphrase);
    expect(decrypted).toBe("ghp_test123");
  });

  test("update credential secret", async () => {
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "old-secret",
      passphrase,
      patterns: [],
    });

    await updateCredentialSecret("github", "new-secret", passphrase);
    const decrypted = await decryptCredentialValue("github", passphrase);
    expect(decrypted).toBe("new-secret");
  });

  test("delete credential", async () => {
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "secret",
      passphrase,
      patterns: ["*.github.com"],
    });

    const deleted = await deleteCredential("github");
    expect(deleted).toBe(true);

    const cred = await getCredentialByService("github");
    expect(cred).toBeNull();
  });

  test("delete nonexistent returns false", async () => {
    const deleted = await deleteCredential("nonexistent");
    expect(deleted).toBe(false);
  });

  test("credentials are scoped by agent ID", async () => {
    setAgentId("agent-1");
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "agent1-secret",
      passphrase,
      patterns: [],
    });

    setAgentId("agent-2");
    await createCredential({
      service: "github",
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret: "agent2-secret",
      passphrase,
      patterns: [],
    });

    // Agent 1 sees only its own credential
    setAgentId("agent-1");
    const list1 = await listCredentials();
    expect(list1.length).toBe(1);
    const decrypted1 = await decryptCredentialValue("github", passphrase);
    expect(decrypted1).toBe("agent1-secret");

    // Agent 2 sees only its own credential
    setAgentId("agent-2");
    const list2 = await listCredentials();
    expect(list2.length).toBe(1);
    const decrypted2 = await decryptCredentialValue("github", passphrase);
    expect(decrypted2).toBe("agent2-secret");

    // Agent 0 sees nothing (different agent scope)
    setAgentId("default");
    const list0 = await listCredentials();
    expect(list0.length).toBe(0);
  });

  test("passphrases are scoped per agent", async () => {
    // Register passphrase for agent-a
    setAgentId("agent-a");
    const hashA = hashPassphrase("pass-for-a");
    await setMeta(passphraseHashKey(), hashA.hash);
    await setMeta(passphraseSaltKey(), hashA.salt);

    // Register passphrase for agent-b
    setAgentId("agent-b");
    const hashB = hashPassphrase("pass-for-b");
    await setMeta(passphraseHashKey(), hashB.hash);
    await setMeta(passphraseSaltKey(), hashB.salt);

    // Verify agent-a passphrase
    setAgentId("agent-a");
    const storedHashA = await getMeta(passphraseHashKey());
    const storedSaltA = await getMeta(passphraseSaltKey());
    expect(verifyPassphrase("pass-for-a", storedHashA!, storedSaltA!)).toBe(true);
    expect(verifyPassphrase("pass-for-b", storedHashA!, storedSaltA!)).toBe(false);

    // Verify agent-b passphrase
    setAgentId("agent-b");
    const storedHashB = await getMeta(passphraseHashKey());
    const storedSaltB = await getMeta(passphraseSaltKey());
    expect(verifyPassphrase("pass-for-b", storedHashB!, storedSaltB!)).toBe(true);
    expect(verifyPassphrase("pass-for-a", storedHashB!, storedSaltB!)).toBe(false);

    // Default agent (0) has no passphrase
    setAgentId("default");
    const storedHash0 = await getMeta(passphraseHashKey());
    expect(storedHash0).toBeNull();
  });
});
