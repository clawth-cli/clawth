import { listCredentials, getAgentId } from "../db/repository.ts";
import { getPassphrase } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";

interface ListOptions {
  verbose?: boolean;
}

export async function listCommand(opts: ListOptions): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const creds = await listCredentials();
  const agentId = getAgentId();

  if (creds.length === 0) {
    console.error(`No credentials stored for agent '${agentId}'.`);
    return;
  }

  if (opts.verbose) {
    console.log(`Agent: ${agentId}`);
    console.log();
    for (const cred of creds) {
      console.log(`${cred.service}`);
      console.log(`  Type: ${cred.type}`);
      console.log(`  Inject: ${cred.injectMethod} → ${cred.injectName}`);
      console.log(`  Template: ${cred.injectTemplate}`);
      console.log(`  Patterns: ${cred.patterns.join(", ") || "(none)"}`);
      console.log(`  Created: ${new Date(cred.createdAt * 1000).toISOString()}`);
      console.log(`  Updated: ${new Date(cred.updatedAt * 1000).toISOString()}`);
      console.log();
    }
  } else {
    const maxService = Math.max(...creds.map((c) => c.service.length), 7);
    const maxType = Math.max(...creds.map((c) => c.type.length), 4);

    console.log(
      `${"SERVICE".padEnd(maxService)}  ${"TYPE".padEnd(maxType)}  PATTERNS`,
    );
    console.log(
      `${"─".repeat(maxService)}  ${"─".repeat(maxType)}  ${"─".repeat(30)}`,
    );

    for (const cred of creds) {
      console.log(
        `${cred.service.padEnd(maxService)}  ${cred.type.padEnd(maxType)}  ${cred.patterns.join(", ") || "(none)"}`,
      );
    }
  }
}
