import { getPassphrase } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { performPkceLogin } from "../auth/strategies/oauth2-pkce.ts";
import { getCredentialByService } from "../db/repository.ts";

export async function loginCommand(service: string): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const cred = await getCredentialByService(service);
  if (!cred) {
    console.error(`Credential '${service}' not found.`);
    process.exit(1);
  }

  if (cred.type !== "oauth2_pkce") {
    console.error(
      `'clawth login' is only for OAuth2 PKCE credentials. '${service}' is type '${cred.type}'.`,
    );
    process.exit(1);
  }

  await performPkceLogin(service, passphrase);
}
