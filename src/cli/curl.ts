import { parseCurlArgs } from "../curl/parser.ts";
import { injectAuth } from "../curl/injector.ts";
import { executeCurl } from "../curl/executor.ts";
import { resolveServiceForUrl, resolveAuth } from "../auth/resolver.ts";
import {
  getCredentialByService,
  getAgentId,
  createCredential,
} from "../db/repository.ts";
import {
  getPassphraseWithSource,
  daemonPingVersion,
  daemonCurl,
  sendToDaemon,
  DAEMON_PROTOCOL_VERSION,
} from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { promptSecret, promptInput } from "../utils/prompt.ts";
import { isRemoteMode } from "../db/postgrest.ts";
import { logAudit } from "../db/audit.ts";
import { emitErrorHint } from "./hints.ts";

interface CurlOptions {
  service?: string;
}

function deriveServiceName(url: string): string {
  const hostname = new URL(url).hostname;
  const parts = hostname.split(".");
  if (parts.length >= 3) return parts[parts.length - 2]!;
  if (parts.length === 2) return parts[0]!;
  return hostname;
}

function derivePattern(url: string): string {
  const hostname = new URL(url).hostname;
  const parts = hostname.split(".");
  if (parts.length >= 3) return `*.${parts.slice(-2).join(".")}`;
  return hostname;
}

async function handleMissingCredential(
  url: string,
  passphrase: string,
): Promise<{ service: string } | null> {
  const service = deriveServiceName(url);
  const pattern = derivePattern(url);
  const interactive = process.stdin.isTTY ?? false;

  if (!interactive) {
    console.error(`CLAWTH_NO_CREDENTIAL`);
    console.error(`url=${url}`);
    console.error(`suggested_service=${service}`);
    console.error(`suggested_pattern=${pattern}`);
    console.error(`suggested_type=bearer`);
    console.error(``);
    console.error(`To add this credential, run one of:`);
    console.error(``);
    console.error(`  # Let the user provide the secret interactively:`);
    console.error(`  clawth set ${service} --type bearer --pattern "${pattern}"`);
    console.error(``);
    console.error(`  # Or provide the secret directly (if you have it):`);
    console.error(`  clawth set ${service} --type bearer --pattern "${pattern}" --secret <TOKEN>`);
    process.exit(2);
  }

  console.error(`\nNo credential found for: ${url}`);
  console.error(`Suggested service name: ${service}`);
  console.error(`Suggested URL pattern:  ${pattern}\n`);

  const confirmService = await promptInput(`Service name (Enter for '${service}'): `);
  const finalService = confirmService || service;
  const confirmType = await promptInput(`Credential type (Enter for 'bearer'): `);
  const finalType = confirmType || "bearer";
  const confirmPattern = await promptInput(`URL pattern (Enter for '${pattern}'): `);
  const finalPattern = confirmPattern || pattern;

  const secret = await promptSecret("Secret value: ");
  if (!secret) {
    console.error("Aborted — no secret provided.");
    return null;
  }

  await createCredential({
    service: finalService,
    type: finalType,
    injectMethod: "header",
    injectName: "Authorization",
    injectTemplate: finalType === "bearer" ? "Bearer {token}" : "{token}",
    secret,
    passphrase,
    patterns: [finalPattern],
  });

  console.error(`\nCredential '${finalService}' stored. Continuing request...\n`);
  return { service: finalService };
}

function parseStatusCode(stderr: string): number | null {
  const match = stderr.match(/< HTTP\/[\d.]+ (\d{3})/);
  if (match) return parseInt(match[1]!, 10);
  return null;
}

export async function curlCommand(
  args: string[],
  opts: CurlOptions,
): Promise<void> {
  // Phase 4: Try daemon fast path first
  try {
    const version = await daemonPingVersion();
    if (version !== null) {
      if (version !== DAEMON_PROTOCOL_VERSION) {
        // Version mismatch — restart daemon
        await sendToDaemon("stop");
        // Fall through to slow path
      } else {
        // Daemon is running with correct version — use streaming fast path
        await daemonCurl(args, opts.service);
        // daemonCurl calls process.exit, so we never reach here
      }
    }
  } catch {
    // Daemon not available, fall through to slow path
  }

  // ── Slow path (no daemon) ──

  // Phase 2: Source-aware passphrase — skip scrypt verification if from daemon
  const { passphrase, source } = await getPassphraseWithSource();
  if (source !== "daemon") {
    await verifyStoredPassphrase(passphrase);
  }

  // Parse curl args — emit hint on bad args
  let parsed;
  try {
    parsed = parseCurlArgs(args);
  } catch (err: any) {
    emitErrorHint({ error: err });
    if (process.stdin.isTTY) console.error(err.message);
    process.exit(1);
  }

  // Resolve which service to use
  let service = opts.service;
  if (!service) {
    service = (await resolveServiceForUrl(parsed.url)) ?? undefined;
  }
  if (!service && isRemoteMode()) {
    service = (await resolveServiceForUrl(parsed.url)) ?? undefined;
  }
  if (!service) {
    const result = await handleMissingCredential(parsed.url, passphrase);
    if (!result) process.exit(1);
    service = result.service;
  }

  const cred = await getCredentialByService(service);
  if (!cred) {
    emitErrorHint({ service, error: new Error(`Credential not found: ${service}`) });
    if (process.stdin.isTTY) console.error(`Credential '${service}' not found.`);
    process.exit(1);
  }

  // Resolve auth — emit hint on any strategy error
  let authResult;
  try {
    authResult = await resolveAuth({
      agentId: getAgentId(),
      service,
      passphrase,
      credentialId: cred.id,
      url: parsed.url,
      method: parsed.method,
      requestHeaders: parsed.headers,
      body: parsed.body,
    });
  } catch (err: any) {
    const handled = emitErrorHint({ service, url: parsed.url, error: err });
    if (!handled && (process.stdin.isTTY ?? false)) {
      console.error(`Auth error for '${service}': ${err.message}`);
    }
    process.exit(1);
  }

  const tempCertPath = authResult.headers?.["X-Clawth-Temp-Cert"];
  const injected = injectAuth(parsed.url, authResult, parsed.remainingArgs);
  const extraArgs = [...parsed.remainingArgs];

  const result = await executeCurl(
    injected,
    extraArgs,
    parsed.headers,
    tempCertPath,
  );

  const statusCode = parseStatusCode(result.stderr);

  // Audit log (best-effort)
  await logAudit({
    service,
    url: parsed.url,
    method: parsed.method,
    statusCode,
  });

  // Detect auth failure → structured hint
  if (statusCode && (statusCode === 401 || statusCode === 403)) {
    const interactive = process.stdin.isTTY ?? false;
    const type = cred.type ?? "bearer";

    if (!interactive) {
      console.error(``);
      console.error(`CLAWTH_AUTH_EXPIRED`);
      console.error(`service=${service}`);
      console.error(`status=${statusCode}`);
      console.error(`type=${type}`);
      console.error(``);
      console.error(`The credential for '${service}' appears expired or invalid.`);
      console.error(`To update it:`);
      console.error(`  clawth set ${service} --type ${type} --secret <NEW_TOKEN>`);
    } else {
      console.error(`\nWarning: HTTP ${statusCode} — credential '${service}' may be expired.`);
      console.error(`Run 'clawth set ${service} --type ${type} --secret <NEW_TOKEN>' to update it.\n`);
    }
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.exitCode);
}
