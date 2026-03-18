import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dbPath, sessionSocketPath } from "../config/paths.ts";
import { saveConfig, loadConfig, type ClawthConfig } from "../config/store.ts";
import { initializeDatabase } from "../db/connection.ts";
import { setMeta, getMeta, setAgentId, getAgentId } from "../db/repository.ts";
import { configurePostgREST } from "../db/postgrest.ts";
import { hashPassphrase, verifyPassphrase } from "../crypto/kdf.ts";
import { promptInput } from "../utils/prompt.ts";
import { sendToDaemon } from "../session/client.ts";
import { passphraseHashKey, passphraseSaltKey } from "./shared.ts";

// ── Style helpers ──

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const NC = "\x1b[0m";

function getVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(thisDir, "..", "..", "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Types ──

interface SetupOptions {
  passphrase?: string;
  agent?: string;
  remote?: string;
  remoteJwt?: string;
  noSkill?: boolean;
  skillDir?: string;
}

function generatePassphrase(): string {
  return randomBytes(32).toString("base64url");
}

function resolveJwtValue(input: string): string {
  if (existsSync(input)) {
    return readFileSync(input, "utf8").trim();
  }
  return input;
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  const isInteractive = process.stdin.isTTY ?? false;
  const hasFlags = !!(opts.passphrase || opts.agent || opts.remote || opts.remoteJwt);

  if (isInteractive && !hasFlags) {
    return guidedSetup(opts);
  }

  return scriptedSetup(opts);
}

// ── Guided interactive wizard ──────────────────────────────────────────────

async function guidedSetup(opts: SetupOptions): Promise<void> {
  const version = getVersion();

  console.log("");
  console.log(`  ${BOLD}Clawth${NC} ${DIM}v${version}${NC}`);
  console.log(`  ${DIM}API keys for AI agents — encrypted, injected, never exposed.${NC}`);
  console.log("");

  // Detect existing setup
  const existingConfig = loadConfig();
  const hasDb = existsSync(dbPath());

  if (hasDb) {
    // Existing DB found — offer to reuse
    console.log(`  ${GREEN}●${NC} Existing database found.`);

    const passphraseInput = await promptInput(`  ${CYAN}?${NC} Enter your passphrase ${DIM}(or Enter to generate a new one)${NC}: `);

    if (passphraseInput) {
      // Verify the passphrase works
      setAgentId(existingConfig.agent);
      if (existingConfig.remote && existingConfig.remoteJwt) {
        configurePostgREST({ baseUrl: existingConfig.remote, jwt: existingConfig.remoteJwt });
      }
      await initializeDatabase();

      const storedHash = await getMeta(passphraseHashKey());
      const storedSalt = await getMeta(passphraseSaltKey());

      if (storedHash && storedSalt && verifyPassphrase(passphraseInput, storedHash, storedSalt)) {
        console.log(`  ${GREEN}✓${NC} Passphrase verified. Reusing existing credentials.`);

        // Just restart daemon + reinstall skill with current versions
        saveConfig(existingConfig);
        if (!opts.noSkill) installClawthSkill(opts.skillDir);
        installGlobally();
        await spawnSessionDaemon(passphraseInput);

        const version = getVersion();
        console.log("");
        console.log(`  ${GREEN}✓${NC} ${BOLD}Ready!${NC} ${DIM}v${version}${NC}`);
        console.log(`    Agent: ${existingConfig.agent} ${DIM}(${existingConfig.remote ? "remote" : "local"})${NC}`);
        console.log("");
        console.log(`  ${CYAN}clawth creds${NC}                                    ${DIM}# manage credentials${NC}`);
        console.log(`  ${CYAN}clawth curl https://api.github.com/user${NC}         ${DIM}# make a call${NC}`);
        console.log("");
        return;
      }

      console.log(`  ${YELLOW}!${NC} Passphrase doesn't match. Starting fresh setup.`);
    } else {
      console.log(`  ${DIM}  Generating new passphrase — existing credentials will be re-encrypted on next use.${NC}`);
    }
  }

  // Step 1: Local or remote?
  const dbChoice = await promptInput(`  ${CYAN}?${NC} Database ${DIM}(L)ocal or (r)emote${NC}: `);
  const useRemote = dbChoice.toLowerCase() === "r" || dbChoice.toLowerCase() === "remote";

  let remote: string | undefined;
  let remoteJwt: string | undefined;

  if (useRemote) {
    remote = await promptInput(`  ${CYAN}?${NC} PostgREST URL: `);
    if (!remote) {
      console.log(`    ${DIM}No URL — using local database.${NC}`);
    } else {
      const jwtInput = await promptInput(`  ${CYAN}?${NC} JWT (token or path): `);
      if (!jwtInput) {
        console.log(`    ${DIM}No JWT — using local database.${NC}`);
        remote = undefined;
      } else {
        remoteJwt = resolveJwtValue(jwtInput);
      }
    }
  }

  // Step 2: Agent ID
  const agentInput = await promptInput(`  ${CYAN}?${NC} Agent ID ${DIM}(default)${NC}: `);
  const agent = agentInput || "default";

  // Step 3: Passphrase
  const customPass = await promptInput(`  ${CYAN}?${NC} Passphrase ${DIM}(Enter to auto-generate)${NC}: `);
  let passphrase: string;

  if (customPass) {
    passphrase = customPass;
    console.log(`  ${GREEN}●${NC} Using your passphrase.`);
  } else {
    passphrase = generatePassphrase();
    console.log("");
    console.log(`  ${GREEN}●${NC} Passphrase: ${BOLD}${passphrase}${NC}`);
    console.log(`    ${DIM}Save this if you need to start a new session later.${NC}`);
  }

  // Apply
  await applySetup({ agent, passphrase, remote, remoteJwt, skillDir: opts.skillDir });
}

// ── Scripted setup (flags / env vars / CI) ─────────────────────────────────

async function scriptedSetup(opts: SetupOptions): Promise<void> {
  const agent = opts.agent ?? process.env.CLAWTH_AGENT_ID ?? "default";
  const remote = opts.remote ?? process.env.CLAWTH_REMOTE ?? undefined;
  const rawJwt = opts.remoteJwt ?? process.env.CLAWTH_REMOTE_JWT;
  const remoteJwt = rawJwt ? resolveJwtValue(rawJwt) : undefined;

  if (remote && !remoteJwt) {
    console.log("--remote-jwt is required when using --remote.");
    process.exit(1);
  }

  let passphrase = opts.passphrase ?? process.env.CLAWTH_AGENT_PASSPHRASE ?? "";
  if (!passphrase) {
    passphrase = generatePassphrase();
    console.log(`  ${GREEN}●${NC} Passphrase: ${passphrase}`);
  }

  await applySetup({ agent, passphrase, remote, remoteJwt, skillDir: opts.skillDir, noSkill: opts.noSkill });
}

// ── Shared setup logic ─────────────────────────────────────────────────────

interface ApplyOptions {
  agent: string;
  passphrase: string;
  remote?: string;
  remoteJwt?: string;
  skillDir?: string;
  noSkill?: boolean;
}

async function applySetup(opts: ApplyOptions): Promise<void> {
  const { agent, passphrase, remote, remoteJwt } = opts;

  setAgentId(agent);
  if (remote && remoteJwt) {
    configurePostgREST({ baseUrl: remote, jwt: remoteJwt });
  }

  const cfg: ClawthConfig = { agent };
  if (remote) cfg.remote = remote;
  if (remoteJwt) cfg.remoteJwt = remoteJwt;
  saveConfig(cfg);

  if (!remote) {
    await initializeDatabase();
  }

  const { hash, salt } = hashPassphrase(passphrase);
  await setMeta(passphraseHashKey(), hash);
  await setMeta(passphraseSaltKey(), salt);
  await setMeta("version", "1");

  if (!opts.noSkill) {
    installClawthSkill(opts.skillDir);
  }

  // Install globally BEFORE starting daemon — so the daemon runs
  // from the global install path, not a temp bunx directory
  installGlobally();

  await spawnSessionDaemon(passphrase);

  // Summary
  const version = getVersion();
  console.log("");
  console.log(`  ${GREEN}✓${NC} ${BOLD}Ready!${NC} ${DIM}v${version}${NC}`);
  console.log(`    Agent: ${agent} ${DIM}(${remote ? "remote" : "local"})${NC}`);
  console.log("");
  console.log(`  Next steps — add credentials and use them:`);
  console.log("");
  console.log(`    ${CYAN}clawth creds${NC}                                    ${DIM}# interactive${NC}`);
  console.log(`    ${CYAN}clawth curl https://api.github.com/user${NC}         ${DIM}# make a call${NC}`);
  console.log("");
}

function installGlobally(): void {
  // Always install/update to latest to avoid version mismatch
  try {
    execSync("npm install -g clawth@latest", { stdio: "ignore" });
  } catch {
    try {
      execSync("bun add -g clawth@latest", { stdio: "ignore" });
    } catch {
      // Silent fail — user can still use npx clawth
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function spawnSessionDaemon(passphrase: string): Promise<void> {
  const socketPath = sessionSocketPath();

  if (existsSync(socketPath)) {
    const result = await sendToDaemon("ping");
    if (result.ok) return;
  }

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const daemonScript = join(thisDir, "..", "session", "daemon.ts");

  const child = spawn(
    "sh",
    ["-c", `nohup bun run '${daemonScript}' > /dev/null 2>&1 &`],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        CLAWTH_DAEMON_PASSPHRASE: passphrase,
        CLAWTH_AGENT_ID: getAgentId(),
      },
    },
  );
  child.unref();

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (existsSync(socketPath)) {
      const result = await sendToDaemon("ping");
      if (result.ok) return;
    }
  }
}

function installClawthSkill(customDir?: string): void {
  const skillDir = customDir ?? join(homedir(), ".claude", "skills", "clawth");
  mkdirSync(skillDir, { recursive: true });

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDir, "..", "..");
  const skillSource = join(projectRoot, "skill", "SKILL.md");

  if (!existsSync(skillSource)) return;

  const clawthBin = join(projectRoot, "bin", "clawth.ts");

  let content = readFileSync(skillSource, "utf8");

  content = content.replace(
    /allowed-tools: Bash\(clawth \*\), Bash\(echo \*\)/,
    `allowed-tools: Bash(bun run ${clawthBin} *), Bash(echo *)`,
  );

  content = content.replace(
    /^clawth /gm,
    `bun run ${clawthBin} `,
  );

  writeFileSync(join(skillDir, "SKILL.md"), content);
}
