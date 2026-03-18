import { existsSync, unlinkSync } from "node:fs";
import { dbPath } from "../config/paths.ts";
import { initializeDatabase } from "../db/connection.ts";
import { setMeta, getAgentId } from "../db/repository.ts";
import { hashPassphrase } from "../crypto/kdf.ts";
import { promptSecret, promptConfirm } from "../utils/prompt.ts";
import { passphraseHashKey, passphraseSaltKey } from "./shared.ts";

export async function initCommand(): Promise<void> {
  const path = dbPath();
  const isInteractive = process.stdin.isTTY ?? false;

  if (existsSync(path)) {
    if (isInteractive) {
      const overwrite = await promptConfirm(
        `Database already exists at ${path}. Reinitialize?`,
      );
      if (!overwrite) {
        console.error("Aborted.");
        return;
      }
    }
    unlinkSync(path);
  }

  let passphrase: string;

  if (isInteractive) {
    passphrase = await promptSecret("Set passphrase: ");
    if (!passphrase) {
      console.error("Passphrase cannot be empty.");
      process.exit(1);
    }

    const confirm = await promptSecret("Confirm passphrase: ");
    if (passphrase !== confirm) {
      console.error("Passphrases do not match.");
      process.exit(1);
    }
  } else {
    // Non-interactive: read passphrase from stdin (single line)
    passphrase = await promptSecret("");
    if (!passphrase) {
      console.error("Passphrase cannot be empty. Pipe it via stdin.");
      process.exit(1);
    }
  }

  await initializeDatabase();

  // Store passphrase verification hash scoped to agent
  const { hash, salt } = hashPassphrase(passphrase);
  await setMeta(passphraseHashKey(), hash);
  await setMeta(passphraseSaltKey(), salt);
  await setMeta("version", "1");

  console.error(`Database initialized at ${path}`);
  console.error(`Passphrase registered for agent '${getAgentId()}'.`);
}
