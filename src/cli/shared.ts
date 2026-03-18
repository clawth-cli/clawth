import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dbPath, dataDir, ensureDir } from "../config/paths.ts";
import { saveConfig } from "../config/store.ts";
import { initializeDatabase } from "../db/connection.ts";
import { getMeta, setMeta, getAgentId } from "../db/repository.ts";
import { hashPassphrase, verifyPassphrase } from "../crypto/kdf.ts";
import { isRemoteMode } from "../db/postgrest.ts";

export async function ensureDbInitialized(): Promise<void> {
  if (isRemoteMode()) return;

  const path = dbPath();
  if (!existsSync(path)) {
    await autoInit(path);
    return; // autoInit already called initializeDatabase()
  }
  await initializeDatabase();
}

async function autoInit(path: string): Promise<void> {
  console.error("Database not found — auto-initializing Clawth...");

  ensureDir(dataDir());
  await initializeDatabase();

  const agent = getAgentId();
  saveConfig({ agent });

  const passphrase = randomBytes(32).toString("base64url");
  const { hash, salt } = hashPassphrase(passphrase);
  await setMeta(passphraseHashKey(), hash);
  await setMeta(passphraseSaltKey(), salt);
  await setMeta("version", "1");

  console.error(`  Agent:      ${agent}`);
  console.error(`  Database:   ${path}`);
  console.error(`  Passphrase: ${passphrase}`);
  console.error("");
  console.error("  Save this passphrase — you'll need it to start a session.");
  console.error("  Run 'clawth session start' to cache it for 4 hours.");
  console.error("");
}

/** Meta keys are scoped per agent so each agent has its own passphrase. */
export function passphraseHashKey(): string {
  return `passphrase_verify_hash:${getAgentId()}`;
}

export function passphraseSaltKey(): string {
  return `passphrase_verify_salt:${getAgentId()}`;
}

export async function verifyStoredPassphrase(
  passphrase: string,
): Promise<void> {
  await ensureDbInitialized();

  const hash = await getMeta(passphraseHashKey());
  const salt = await getMeta(passphraseSaltKey());

  if (!hash || !salt) {
    if (isRemoteMode()) {
      return;
    }
    console.error(
      `No passphrase registered for agent '${getAgentId()}'. Run 'clawth setup --agent ${getAgentId()}' first.`,
    );
    process.exit(1);
  }

  if (!verifyPassphrase(passphrase, hash, salt)) {
    console.error("Invalid passphrase.");
    process.exit(1);
  }
}
