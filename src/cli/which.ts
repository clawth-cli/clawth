import { resolveServiceForUrl } from "../auth/resolver.ts";
import { getCredentialWithPatterns } from "../db/repository.ts";
import { ensureDbInitialized } from "./shared.ts";

export async function whichCommand(url: string): Promise<void> {
  await ensureDbInitialized();

  // Ensure URL has a scheme
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  const service = await resolveServiceForUrl(url);

  if (!service) {
    console.error(`No credential matches: ${url}`);
    process.exit(1);
  }

  const cred = await getCredentialWithPatterns(service);
  if (!cred) {
    console.error(`Service '${service}' matched but credential not found.`);
    process.exit(1);
  }

  console.log(`URL:      ${url}`);
  console.log(`Service:  ${cred.service}`);
  console.log(`Type:     ${cred.type}`);
  console.log(`Inject:   ${cred.injectMethod} → ${cred.injectName}`);
  console.log(`Template: ${cred.injectTemplate}`);
  console.log(`Patterns: ${cred.patterns.join(", ")}`);
}
