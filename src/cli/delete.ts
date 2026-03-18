import { deleteCredential } from "../db/repository.ts";
import { getPassphrase, sendToDaemon } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { promptConfirm } from "../utils/prompt.ts";

export async function deleteCommand(service: string): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const confirmed = await promptConfirm(
    `Delete credential '${service}'?`,
  );
  if (!confirmed) {
    console.error("Aborted.");
    return;
  }

  const deleted = await deleteCredential(service);
  if (!deleted) {
    console.error(`Credential '${service}' not found.`);
    process.exit(1);
  }

  // Notify daemon to reload DB (best-effort)
  try {
    await sendToDaemon("reload-db");
  } catch {
    // Daemon may not be running
  }

  console.error(`Credential '${service}' deleted.`);
}
