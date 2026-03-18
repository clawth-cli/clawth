import * as readline from "node:readline";
import {
  listCredentials,
  createCredential,
  createOAuthMetadata,
  deleteCredential,
  updateCredentialSecret,
  getCredentialByService,
} from "../db/repository.ts";
import { getPassphrase, sendToDaemon } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { promptSecret } from "../utils/prompt.ts";
import { PROVIDERS, searchProviders, type ProviderPreset } from "./providers.ts";
import { performPkceLogin } from "../auth/strategies/oauth2-pkce.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const NC = "\x1b[0m";

export async function credsCommand(): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  while (true) {
    console.error("");
    await showCredentials();
    console.error("");

    const choice = await menu([
      "Add a credential",
      "Remove a credential",
      "Update a credential",
      "Exit",
    ]);

    switch (choice) {
      case 0:
        await addCredentialFlow(passphrase);
        break;
      case 1:
        await removeCredentialFlow();
        break;
      case 2:
        await updateCredentialFlow(passphrase);
        break;
      case 3:
        return;
    }
  }
}

// ── Show stored credentials ──

async function showCredentials(): Promise<void> {
  const creds = await listCredentials();

  console.error(`  ${BOLD}Stored Credentials${NC}`);
  console.error(`  ${"─".repeat(40)}`);

  if (creds.length === 0) {
    console.error(`  ${DIM}(none)${NC}`);
    return;
  }

  for (const cred of creds) {
    console.error(
      `  ${GREEN}●${NC} ${BOLD}${cred.service}${NC}  ${DIM}${cred.type}  →  ${cred.patterns.join(", ") || "(no patterns)"}${NC}`,
    );
  }
}

// ── Add credential flow ──

async function addCredentialFlow(passphrase: string): Promise<void> {
  console.error("");
  console.error(`  ${BOLD}Add a credential${NC}`);
  console.error(`  Start typing to search providers, or enter a custom name.`);
  console.error("");

  const selected = await providerAutocomplete();
  if (!selected) return;

  let serviceName: string;
  let preset: ProviderPreset | undefined;

  if (typeof selected === "string") {
    serviceName = selected;
  } else {
    preset = selected;
    serviceName = preset.name;
  }

  // Check if already exists
  const existing = await getCredentialByService(serviceName);
  if (existing) {
    console.error(`  ${YELLOW}Credential '${serviceName}' already exists. Updating secret.${NC}`);
    const secret = await promptSecret("  API key: ");
    if (!secret) {
      console.error("  Cancelled.");
      return;
    }

    if (preset?.validateUrl) {
      const valid = await validateKey(preset, secret);
      if (!valid) return;
    }

    await updateCredentialSecret(serviceName, secret, passphrase);
    console.error(`  ${GREEN}✓${NC} Credential '${serviceName}' updated.`);
    await reloadDaemon();
    return;
  }

  // OAuth2 PKCE flow
  if (preset?.type === "oauth2_pkce" && preset.oauth) {
    await addOAuth2Credential(serviceName, preset, passphrase);
    return;
  }

  // API key / bearer / basic flow
  if (preset) {
    console.error(`  ${DIM}Get your key at: ${preset.keyHint}${NC}`);
  }

  const secret = await promptSecret("  API key: ");
  if (!secret) {
    console.error("  Cancelled.");
    return;
  }

  if (preset?.validateUrl) {
    const valid = await validateKey(preset, secret);
    if (!valid) return;
  }

  if (preset) {
    await createCredential({
      service: serviceName,
      type: preset.type,
      injectMethod: preset.injectMethod,
      injectName: preset.injectName,
      injectTemplate: preset.injectTemplate,
      secret: preset.type === "basic" ? Buffer.from(secret).toString("base64") : secret,
      passphrase,
      patterns: preset.patterns,
    });
  } else {
    const patterns = await promptInputLine("  URL pattern (e.g., *.example.com): ");
    if (!patterns) {
      console.error("  Cancelled.");
      return;
    }

    await createCredential({
      service: serviceName,
      type: "bearer",
      injectMethod: "header",
      injectName: "Authorization",
      injectTemplate: "Bearer {token}",
      secret,
      passphrase,
      patterns: [patterns],
    });
  }

  console.error(`  ${GREEN}✓${NC} Credential '${serviceName}' stored.`);
  await reloadDaemon();
}

async function addOAuth2Credential(
  serviceName: string,
  preset: ProviderPreset,
  passphrase: string,
): Promise<void> {
  const oauth = preset.oauth!;

  console.error(`  ${CYAN}This provider uses OAuth2 — browser login required.${NC}`);
  console.error(`  ${DIM}${preset.keyHint}${NC}`);
  console.error("");

  const clientId = await promptInputLine("  OAuth2 Client ID: ");
  if (!clientId) {
    console.error("  Cancelled.");
    return;
  }

  // Create the credential entry + OAuth metadata
  const credentialId = await createCredential({
    service: serviceName,
    type: "oauth2_pkce",
    injectMethod: preset.injectMethod,
    injectName: preset.injectName,
    injectTemplate: preset.injectTemplate,
    secret: "pkce_placeholder",
    passphrase,
    patterns: preset.patterns,
  });

  await createOAuthMetadata({
    credentialId,
    tokenUrl: oauth.tokenUrl,
    authorizeUrl: oauth.authorizeUrl,
    clientId,
    scopes: oauth.scopes,
    usePkce: true,
    passphrase,
    service: serviceName,
  });

  // Launch browser login
  console.error("");
  try {
    await performPkceLogin(serviceName, passphrase);
    console.error(`  ${GREEN}✓${NC} OAuth2 login complete for '${serviceName}'.`);
  } catch (err: any) {
    console.error(`  ${RED}✗${NC} OAuth2 login failed: ${err.message}`);
    console.error(`  You can retry later with: clawth login ${serviceName}`);
  }

  await reloadDaemon();
}

// ── Remove credential flow ──

async function removeCredentialFlow(): Promise<void> {
  const creds = await listCredentials();
  if (creds.length === 0) {
    console.error("  No credentials to remove.");
    return;
  }

  console.error("");
  const idx = await menu(creds.map((c) => `${c.service} (${c.type})`));
  if (idx < 0 || idx >= creds.length) return;

  const service = creds[idx]!.service;
  await deleteCredential(service);
  console.error(`  ${GREEN}✓${NC} Credential '${service}' deleted.`);
  await reloadDaemon();
}

// ── Update credential flow ──

async function updateCredentialFlow(passphrase: string): Promise<void> {
  const creds = await listCredentials();
  if (creds.length === 0) {
    console.error("  No credentials to update.");
    return;
  }

  console.error("");
  const idx = await menu(creds.map((c) => `${c.service} (${c.type})`));
  if (idx < 0 || idx >= creds.length) return;

  const service = creds[idx]!.service;
  const preset = PROVIDERS.find((p) => p.name === service);

  if (preset) {
    console.error(`  ${DIM}Get your key at: ${preset.keyHint}${NC}`);
  }

  const secret = await promptSecret("  New API key: ");
  if (!secret) {
    console.error("  Cancelled.");
    return;
  }

  if (preset?.validateUrl) {
    const valid = await validateKey(preset, secret);
    if (!valid) return;
  }

  await updateCredentialSecret(service, secret, passphrase);
  console.error(`  ${GREEN}✓${NC} Credential '${service}' updated.`);
  await reloadDaemon();
}

// ── Key validation ──

async function validateKey(
  preset: ProviderPreset,
  secret: string,
): Promise<boolean> {
  if (!preset.validateUrl) return true;

  process.stderr.write(`  Validating...`);

  try {
    let url = preset.validateUrl;
    const headers: Record<string, string> = {};

    if (preset.injectMethod === "query_param") {
      const u = new URL(url);
      u.searchParams.set(preset.injectName, secret);
      url = u.toString();
    } else {
      const value = preset.injectTemplate.replace(
        "{token}",
        preset.type === "basic"
          ? Buffer.from(secret).toString("base64")
          : secret,
      );
      headers[preset.injectName] = value;
    }

    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    const okCodes = preset.validateOk ?? [200];
    if (okCodes.includes(resp.status) || (resp.status >= 200 && resp.status < 300)) {
      console.error(`\r  ${GREEN}✓ Key is valid${NC}          `);
      return true;
    }

    if (resp.status === 401 || resp.status === 403) {
      console.error(`\r  ${RED}✗ Invalid key (HTTP ${resp.status})${NC}          `);
      return false;
    }

    // Other status — warn but allow
    console.error(`\r  ${YELLOW}? Got HTTP ${resp.status} — key might be valid${NC}          `);
    return true;
  } catch (err: any) {
    console.error(`\r  ${YELLOW}? Could not validate: ${err.message}${NC}          `);
    return true; // Network error — don't block
  }
}

// ── Interactive widgets ──

async function menu(items: string[]): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.error(`  ${BOLD}${i + 1})${NC} ${items[i]}`);
  }
  console.error("");

  const answer = await promptInputLine("  Choice: ");
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) return items.length - 1;
  return idx;
}

function promptInputLine(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Autocomplete provider search.
 * User types characters, sees matching providers updating in real-time.
 * Press Enter to select, or type a custom name.
 */
async function providerAutocomplete(): Promise<ProviderPreset | string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    let query = "";
    let matches = PROVIDERS.slice(0, 8);
    let selectedIdx = 0;

    function render() {
      // Clear previous output
      const clearLines = matches.length + 3;
      for (let i = 0; i < clearLines; i++) {
        process.stderr.write("\x1b[2K"); // Clear line
        if (i < clearLines - 1) process.stderr.write("\x1b[A"); // Move up
      }
      process.stderr.write("\r");

      // Input line
      process.stderr.write(`  ${BOLD}Provider:${NC} ${query}\n`);

      // Matches
      const filtered = searchProviders(query).slice(0, 8);
      matches = filtered;
      if (selectedIdx >= matches.length) selectedIdx = Math.max(0, matches.length - 1);

      if (matches.length === 0) {
        process.stderr.write(`  ${DIM}No matches — Enter to use "${query}" as custom service${NC}\n`);
        process.stderr.write("\n");
      } else {
        for (let i = 0; i < matches.length; i++) {
          const p = matches[i]!;
          const prefix = i === selectedIdx ? `${CYAN}❯${NC}` : " ";
          const name = i === selectedIdx ? `${BOLD}${p.displayName}${NC}` : p.displayName;
          process.stderr.write(`  ${prefix} ${name}  ${DIM}${p.patterns.join(", ")}${NC}\n`);
        }
        process.stderr.write("\n");
      }
    }

    // Initial render — write empty lines first so render can clear them
    for (let i = 0; i < matches.length + 3; i++) {
      process.stderr.write("\n");
    }
    render();

    if (stdin.setRawMode) stdin.setRawMode(true);

    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8");

      if (ch === "\r" || ch === "\n") {
        // Select
        cleanup();
        if (matches.length > 0 && selectedIdx < matches.length) {
          resolve(matches[selectedIdx]!);
        } else if (query) {
          resolve(query);
        } else {
          resolve(null);
        }
        return;
      }

      if (ch === "\x1b[A") {
        // Up arrow
        if (selectedIdx > 0) selectedIdx--;
        render();
        return;
      }

      if (ch === "\x1b[B") {
        // Down arrow
        if (selectedIdx < matches.length - 1) selectedIdx++;
        render();
        return;
      }

      if (ch === "\x09") {
        // Tab — accept current selection into query
        if (matches.length > 0 && selectedIdx < matches.length) {
          query = matches[selectedIdx]!.name;
          selectedIdx = 0;
        }
        render();
        return;
      }

      if (ch === "\x7f" || ch === "\b") {
        // Backspace
        query = query.slice(0, -1);
        selectedIdx = 0;
        render();
        return;
      }

      if (ch === "\x03") {
        // Ctrl+C
        cleanup();
        resolve(null);
        return;
      }

      // Regular character
      if (ch.length === 1 && ch >= " ") {
        query += ch;
        selectedIdx = 0;
        render();
      }
    };

    function cleanup() {
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      // Clear the autocomplete UI
      for (let i = 0; i < matches.length + 3; i++) {
        process.stderr.write("\x1b[2K");
        if (i < matches.length + 2) process.stderr.write("\x1b[A");
      }
      process.stderr.write("\r");
    }

    stdin.on("data", onData);
  });
}

async function reloadDaemon(): Promise<void> {
  try {
    await sendToDaemon("reload-db");
  } catch {
    // Daemon may not be running
  }
}
