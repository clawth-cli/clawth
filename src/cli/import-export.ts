import { readFileSync, writeFileSync } from "node:fs";
import { listCredentials, createCredential, getCredentialByService, deleteCredential, getAllUrlPatterns } from "../db/repository.ts";
import { decrypt, encrypt, type EncryptedPayload } from "../crypto/encryption.ts";
import { getPassphrase } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { promptSecret } from "../utils/prompt.ts";
import { getAgentId } from "../db/repository.ts";

interface ExportedCredential {
  service: string;
  type: string;
  injectMethod: string;
  injectName: string;
  injectTemplate: string;
  patterns: string[];
  /** Encrypted with the transport passphrase, not the agent passphrase */
  encryptedSecret: EncryptedPayload;
}

interface ExportBundle {
  version: 1;
  agentId: string;
  exportedAt: string;
  credentials: ExportedCredential[];
}

export async function exportCommand(file: string): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const transportPass = await promptSecret("Transport passphrase (to encrypt the export): ");
  if (!transportPass) {
    console.error("Transport passphrase cannot be empty.");
    process.exit(1);
  }

  const creds = await listCredentials();
  if (creds.length === 0) {
    console.error("No credentials to export.");
    process.exit(1);
  }

  const agentId = getAgentId();
  const exported: ExportedCredential[] = [];

  for (const cred of creds) {
    const fullCred = await getCredentialByService(cred.service);
    if (!fullCred) continue;

    // Decrypt with agent passphrase
    const payload: EncryptedPayload = {
      ciphertext: fullCred.encryptedValue,
      iv: fullCred.iv,
      authTag: fullCred.authTag,
      salt: fullCred.salt,
    };
    const plainSecret = await decrypt(payload, passphrase, `${agentId}:${cred.service}`);

    // Re-encrypt with transport passphrase
    const transportEncrypted = encrypt(plainSecret, transportPass, `export:${cred.service}`);

    exported.push({
      service: cred.service,
      type: cred.type,
      injectMethod: cred.injectMethod,
      injectName: cred.injectName,
      injectTemplate: cred.injectTemplate,
      patterns: cred.patterns,
      encryptedSecret: transportEncrypted,
    });
  }

  const bundle: ExportBundle = {
    version: 1,
    agentId,
    exportedAt: new Date().toISOString(),
    credentials: exported,
  };

  writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  console.error(`Exported ${exported.length} credentials to ${file}`);
}

export async function importCommand(file: string): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const transportPass = await promptSecret("Transport passphrase (used during export): ");
  if (!transportPass) {
    console.error("Transport passphrase cannot be empty.");
    process.exit(1);
  }

  const raw = readFileSync(file, "utf8");
  const bundle = JSON.parse(raw) as ExportBundle;

  if (bundle.version !== 1) {
    console.error(`Unsupported export version: ${bundle.version}`);
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  for (const cred of bundle.credentials) {
    // Check if already exists
    const existing = await getCredentialByService(cred.service);
    if (existing) {
      console.error(`  Skipping '${cred.service}' (already exists)`);
      skipped++;
      continue;
    }

    // Decrypt with transport passphrase
    const plainSecret = await decrypt(cred.encryptedSecret, transportPass, `export:${cred.service}`);

    await createCredential({
      service: cred.service,
      type: cred.type,
      injectMethod: cred.injectMethod as "header" | "query_param",
      injectName: cred.injectName,
      injectTemplate: cred.injectTemplate,
      secret: plainSecret,
      passphrase,
      patterns: cred.patterns,
    });

    console.error(`  Imported '${cred.service}' (${cred.type})`);
    imported++;
  }

  console.error(`\nDone: ${imported} imported, ${skipped} skipped.`);
}
