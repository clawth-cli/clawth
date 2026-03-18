import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dbPath, sessionSocketPath } from "../config/paths.ts";
import { saveConfig, type ClawthConfig } from "../config/store.ts";
import { initializeDatabase } from "../db/connection.ts";
import { setMeta, setAgentId, getAgentId } from "../db/repository.ts";
import { configurePostgREST } from "../db/postgrest.ts";
import { hashPassphrase } from "../crypto/kdf.ts";
import { promptSecret, promptInput, promptConfirm } from "../utils/prompt.ts";
import { sendToDaemon } from "../session/client.ts";
import { passphraseHashKey, passphraseSaltKey } from "./shared.ts";

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

  // If interactive with no flags → guided wizard
  if (isInteractive && !hasFlags) {
    return guidedSetup(opts);
  }

  // Otherwise: scripted setup (flags + env vars)
  return scriptedSetup(opts);
}

// ── Guided interactive wizard ──────────────────────────────────────────────

async function guidedSetup(opts: SetupOptions): Promise<void> {
  console.error("");
  console.error("  Welcome to Clawth");
  console.error("  API keys for AI agents — encrypted, injected, never exposed.");
  console.error("");

  // Step 1: Local or remote?
  const dbChoice = await promptInput("  Database — local or remote? (L/r): ");
  const useRemote = dbChoice.toLowerCase() === "r" || dbChoice.toLowerCase() === "remote";

  let remote: string | undefined;
  let remoteJwt: string | undefined;

  if (useRemote) {
    remote = await promptInput("  PostgREST URL: ");
    if (!remote) {
      console.error("  URL cannot be empty. Falling back to local.");
    } else {
      const jwtInput = await promptInput("  JWT (token or path to file): ");
      if (!jwtInput) {
        console.error("  JWT cannot be empty. Falling back to local.");
        remote = undefined;
      } else {
        remoteJwt = resolveJwtValue(jwtInput);
      }
    }
  }

  // Step 2: Agent ID
  const agentInput = await promptInput("  Agent ID (Enter for 'default'): ");
  const agent = agentInput || "default";

  // Step 3: Passphrase — auto-generated, no question
  const passphrase = generatePassphrase();
  console.error(`  Passphrase: ${passphrase}`);
  console.error(`  ${"\x1b[2m"}(save this if you need to start a new session later)${"\x1b[0m"}`);
  console.error("");

  // Apply and save
  await applySetup({ agent, passphrase, remote, remoteJwt, skillDir: opts.skillDir });
}

// ── Scripted setup (flags / env vars / CI) ─────────────────────────────────

async function scriptedSetup(opts: SetupOptions): Promise<void> {
  const agent = opts.agent ?? process.env.CLAWTH_AGENT_ID ?? "default";
  const remote = opts.remote ?? process.env.CLAWTH_REMOTE ?? undefined;
  const rawJwt = opts.remoteJwt ?? process.env.CLAWTH_REMOTE_JWT;
  const remoteJwt = rawJwt ? resolveJwtValue(rawJwt) : undefined;

  if (remote && !remoteJwt) {
    console.error("  --remote-jwt is required when using --remote.");
    process.exit(1);
  }

  let passphrase = opts.passphrase ?? process.env.CLAWTH_AGENT_PASSPHRASE ?? "";
  if (!passphrase) {
    passphrase = generatePassphrase();
    console.error(`  Generated passphrase: ${passphrase}`);
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

  // Configure runtime
  setAgentId(agent);
  if (remote && remoteJwt) {
    configurePostgREST({ baseUrl: remote, jwt: remoteJwt });
  }

  // Persist config
  const cfg: ClawthConfig = { agent };
  if (remote) cfg.remote = remote;
  if (remoteJwt) cfg.remoteJwt = remoteJwt;
  saveConfig(cfg);

  // Initialize database (creates if missing, opens if exists)
  if (!remote) {
    await initializeDatabase();
  }

  // Register passphrase for this agent
  const { hash, salt } = hashPassphrase(passphrase);
  await setMeta(passphraseHashKey(), hash);
  await setMeta(passphraseSaltKey(), salt);
  await setMeta("version", "1");

  // Install skill
  if (!opts.noSkill) {
    installClawthSkill(opts.skillDir);
  }

  // Start session daemon
  await spawnSessionDaemon(passphrase);

  // Install globally so `clawth` works directly
  installGlobally();

  // Summary
  console.error("");
  console.error("  Ready!");
  console.error(`  Agent: ${agent} (${remote ? "remote" : "local"})`);
  console.error("");
  console.error("  Next steps — add a credential then use it:");
  console.error("");
  console.error(`    clawth set github --type bearer --pattern "*.github.com"`);
  console.error(`    clawth curl https://api.github.com/user`);
  console.error("");
}

function installGlobally(): void {
  // Check if clawth is already globally available
  try {
    execSync("clawth --version", { stdio: "ignore" });
    return; // Already installed
  } catch {
    // Not installed — continue
  }

  try {
    // Try npm first (most common)
    execSync("npm install -g clawth", { stdio: "ignore" });
  } catch {
    // npm failed (permissions?) — try with bun
    try {
      execSync("bun add -g clawth", { stdio: "ignore" });
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
    if (result.ok) {
      return; // Already running
    }
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
