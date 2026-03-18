import { listCredentials, getCredentialByService, getAgentId } from "../db/repository.ts";
import { resolveAuth } from "../auth/resolver.ts";
import { getPassphrase } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";

export async function checkCommand(service?: string): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const creds = service
    ? [await getCredentialByService(service)].filter(Boolean)
    : await listCredentials();

  if (creds.length === 0) {
    console.error(service ? `Credential '${service}' not found.` : "No credentials stored.");
    process.exit(1);
  }

  let allOk = true;

  for (const cred of creds) {
    const name = cred!.service;
    const type = cred!.type;
    process.stderr.write(`  ${name} (${type}) ... `);

    try {
      // Verify we can resolve auth (decrypt + strategy logic)
      const fullCred = await getCredentialByService(name);
      if (!fullCred) {
        console.error("NOT FOUND");
        allOk = false;
        continue;
      }

      await resolveAuth({
        agentId: getAgentId(),
        service: name,
        passphrase,
        credentialId: fullCred.id,
        url: "https://health-check.internal",
        method: "GET",
        requestHeaders: {},
      });

      console.error("OK (decrypts successfully)");
    } catch (err: any) {
      console.error(`FAIL (${err.message})`);
      allOk = false;
    }
  }

  if (!allOk) {
    process.exit(1);
  }
}
