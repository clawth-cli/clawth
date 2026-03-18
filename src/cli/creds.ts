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

const MAX_VISIBLE = 10;

export async function credsCommand(): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  while (true) {
    console.log("");
    await showCredentials();
    console.log("");

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

  console.log(`  ${BOLD}Stored Credentials${NC}`);
  console.log(`  ${"─".repeat(40)}`);

  if (creds.length === 0) {
    console.log(`  ${DIM}(none)${NC}`);
    return;
  }

  for (const cred of creds) {
    console.log(
      `  ${GREEN}●${NC} ${BOLD}${cred.service}${NC}  ${DIM}${cred.type}  →  ${cred.patterns.join(", ") || "(no patterns)"}${NC}`,
    );
  }
}

// ── Add credential flow ──

async function addCredentialFlow(passphrase: string): Promise<void> {
  console.log("");
  console.log(`  ${BOLD}Add a credential${NC}`);
  console.log("");

  const selected = await providerSearch();
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
    console.log(`  ${YELLOW}Credential '${serviceName}' already exists. Updating secret.${NC}`);
    const secret = await promptSecret("  API key: ");
    if (!secret) {
      console.log("  Cancelled.");
      return;
    }

    if (preset?.validateUrl) {
      const valid = await validateKey(preset, secret);
      if (!valid) return;
    }

    await updateCredentialSecret(serviceName, secret, passphrase);
    console.log(`  ${GREEN}✓${NC} Credential '${serviceName}' updated.`);
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
    console.log(`  ${DIM}Get your key at: ${preset.keyHint}${NC}`);
  }

  const secret = await promptSecret("  API key: ");
  if (!secret) {
    console.log("  Cancelled.");
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
      console.log("  Cancelled.");
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

  console.log(`  ${GREEN}✓${NC} Credential '${serviceName}' stored.`);
  await reloadDaemon();
}

async function addOAuth2Credential(
  serviceName: string,
  preset: ProviderPreset,
  passphrase: string,
): Promise<void> {
  const oauth = preset.oauth!;

  console.log(`  ${CYAN}This provider uses OAuth2 — browser login required.${NC}`);
  console.log(`  ${DIM}${preset.keyHint}${NC}`);
  console.log("");

  const clientId = await promptInputLine("  OAuth2 Client ID: ");
  if (!clientId) {
    console.log("  Cancelled.");
    return;
  }

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

  console.log("");
  try {
    await performPkceLogin(serviceName, passphrase);
    console.log(`  ${GREEN}✓${NC} OAuth2 login complete for '${serviceName}'.`);
  } catch (err: any) {
    console.log(`  ${RED}✗${NC} OAuth2 login failed: ${err.message}`);
    console.log(`  You can retry later with: clawth login ${serviceName}`);
  }

  await reloadDaemon();
}

// ── Remove credential flow ──

async function removeCredentialFlow(): Promise<void> {
  const creds = await listCredentials();
  if (creds.length === 0) {
    console.log("  No credentials to remove.");
    return;
  }

  console.log("");
  const idx = await menu(creds.map((c) => `${c.service} (${c.type})`));
  if (idx < 0 || idx >= creds.length) return;

  const service = creds[idx]!.service;
  await deleteCredential(service);
  console.log(`  ${GREEN}✓${NC} Credential '${service}' deleted.`);
  await reloadDaemon();
}

// ── Update credential flow ──

async function updateCredentialFlow(passphrase: string): Promise<void> {
  const creds = await listCredentials();
  if (creds.length === 0) {
    console.log("  No credentials to update.");
    return;
  }

  console.log("");
  const idx = await menu(creds.map((c) => `${c.service} (${c.type})`));
  if (idx < 0 || idx >= creds.length) return;

  const service = creds[idx]!.service;
  const preset = PROVIDERS.find((p) => p.name === service);

  if (preset) {
    console.log(`  ${DIM}Get your key at: ${preset.keyHint}${NC}`);
  }

  const secret = await promptSecret("  New API key: ");
  if (!secret) {
    console.log("  Cancelled.");
    return;
  }

  if (preset?.validateUrl) {
    const valid = await validateKey(preset, secret);
    if (!valid) return;
  }

  await updateCredentialSecret(service, secret, passphrase);
  console.log(`  ${GREEN}✓${NC} Credential '${service}' updated.`);
  await reloadDaemon();
}

// ── Key validation ──

async function validateKey(
  preset: ProviderPreset,
  secret: string,
): Promise<boolean> {
  if (!preset.validateUrl) return true;

  process.stdout.write(`  Validating...`);

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
      console.log(`\r  ${GREEN}✓ Key is valid${NC}          `);
      return true;
    }

    if (resp.status === 401 || resp.status === 403) {
      console.log(`\r  ${RED}✗ Invalid key (HTTP ${resp.status})${NC}          `);
      return false;
    }

    console.log(`\r  ${YELLOW}? Got HTTP ${resp.status} — key might be valid${NC}          `);
    return true;
  } catch (err: any) {
    console.log(`\r  ${YELLOW}? Could not validate: ${err.message}${NC}          `);
    return true;
  }
}

// ── Interactive widgets ──

async function menu(items: string[]): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${BOLD}${i + 1})${NC} ${items[i]}`);
  }
  console.log("");

  const answer = await promptInputLine("  Choice: ");
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) return items.length - 1;
  return idx;
}

function promptInputLine(message: string): Promise<string> {
  if (process.stdin.isPaused()) process.stdin.resume();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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
 * Interactive provider search using readline.
 * Uses readline's built-in key handling (no raw mode issues).
 */
async function providerSearch(): Promise<ProviderPreset | string | null> {
  const stdin = process.stdin;

  // Ensure stdin is in flowing mode and not paused from previous readline usage
  if (stdin.isPaused()) stdin.resume();

  return new Promise((resolve) => {
    let query = "";
    let matches = PROVIDERS.slice(0, MAX_VISIBLE);
    let selectedIdx = 0;
    let totalLines = 0;
    let finished = false;
    const out = process.stdout;

    function render() {
      // Move to start and clear everything we previously drew
      if (totalLines > 0) {
        out.write(`\x1b[${totalLines}A`); // move up
      }
      out.write("\r");

      const lines: string[] = [];

      lines.push(`  ${CYAN}/${NC} ${query}${DIM}│${NC}\x1b[K`);

      const filtered = searchProviders(query).slice(0, MAX_VISIBLE);
      matches = filtered;
      if (selectedIdx >= matches.length) selectedIdx = Math.max(0, matches.length - 1);

      if (matches.length === 0 && query) {
        lines.push(`  ${DIM}No matches — Enter to use "${query}" as custom service${NC}\x1b[K`);
      } else {
        for (let i = 0; i < matches.length; i++) {
          const p = matches[i]!;
          if (i === selectedIdx) {
            lines.push(`  ${CYAN}❯${NC} ${BOLD}${p.displayName}${NC}  ${DIM}${p.patterns.join(", ")}${NC}\x1b[K`);
          } else {
            lines.push(`    ${p.displayName}  ${DIM}${p.patterns.join(", ")}${NC}\x1b[K`);
          }
        }
      }

      lines.push(`  ${DIM}↑↓ navigate  Enter select  Esc cancel${NC}\x1b[K`);

      // If previous render had more lines, clear the extra ones
      const prevTotal = totalLines;
      totalLines = lines.length;
      for (let i = lines.length; i < prevTotal; i++) {
        lines.push("\x1b[K"); // clear leftover line
      }

      out.write(lines.join("\n"));
    }

    // Reserve space and do initial render
    out.write("\n".repeat(MAX_VISIBLE + 2));
    totalLines = MAX_VISIBLE + 2;
    render();

    // Enter raw mode
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);

    let escBuf = "";
    let escTimeout: ReturnType<typeof setTimeout> | null = null;

    function finish(result: ProviderPreset | string | null) {
      if (finished) return;
      finished = true;
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      if (escTimeout) clearTimeout(escTimeout);
      // Clear the search UI
      if (totalLines > 0) {
        out.write(`\x1b[${totalLines}A`);
        out.write("\r");
        for (let i = 0; i <= totalLines; i++) {
          out.write("\x1b[2K\n");
        }
        out.write(`\x1b[${totalLines + 1}A`);
        out.write("\r");
      }
      if (result && typeof result !== "string") {
        console.log(`  Selected: ${BOLD}${result.displayName}${NC}`);
      } else if (result) {
        console.log(`  Custom service: ${BOLD}${result}${NC}`);
      }
      resolve(result);
    }

    function processKey(key: string) {
      // Escape
      if (key === "\x1b" && escBuf === "") {
        // Could be start of escape sequence or standalone Esc
        escBuf = "\x1b";
        escTimeout = setTimeout(() => {
          escBuf = "";
          finish(null);
        }, 50);
        return;
      }

      // Escape sequence continuation
      if (escBuf === "\x1b") {
        if (escTimeout) clearTimeout(escTimeout);
        escBuf += key;
        if (escBuf === "\x1b[") {
          // Wait for final char
          return;
        }
        // Process complete sequence
        processEscapeSequence(escBuf);
        escBuf = "";
        return;
      }

      if (escBuf === "\x1b[") {
        escBuf += key;
        processEscapeSequence(escBuf);
        escBuf = "";
        return;
      }

      escBuf = "";

      // Enter
      if (key === "\r" || key === "\n") {
        if (matches.length > 0 && selectedIdx < matches.length) {
          finish(matches[selectedIdx]!);
        } else if (query) {
          finish(query);
        } else {
          finish(null);
        }
        return;
      }

      // Ctrl+C
      if (key === "\x03") {
        finish(null);
        return;
      }

      // Tab — fill query with selected
      if (key === "\x09") {
        if (matches.length > 0 && selectedIdx < matches.length) {
          query = matches[selectedIdx]!.name;
          selectedIdx = 0;
        }
        render();
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        query = query.slice(0, -1);
        selectedIdx = 0;
        render();
        return;
      }

      // Printable character
      if (key.length === 1 && key >= " ") {
        query += key;
        selectedIdx = 0;
        render();
      }
    }

    function processEscapeSequence(seq: string) {
      if (seq === "\x1b[A") {
        // Up
        if (selectedIdx > 0) selectedIdx--;
        render();
      } else if (seq === "\x1b[B") {
        // Down
        if (selectedIdx < matches.length - 1) selectedIdx++;
        render();
      }
      // Ignore other sequences
    }

    function onData(buf: Buffer) {
      // Process each byte/char separately for escape sequence handling
      const str = buf.toString("utf8");
      for (const ch of str) {
        processKey(ch);
      }
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
