import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dbPath, sessionSocketPath } from "../config/paths.ts";
import { saveConfig, type ClawthConfig } from "../config/store.ts";
import { initializeDatabase } from "../db/connection.ts";
import { setMeta, setAgentId, getAgentId } from "../db/repository.ts";
import { configurePostgREST } from "../db/postgrest.ts";
import { hashPassphrase } from "../crypto/kdf.ts";
import { promptSecret, promptConfirm } from "../utils/prompt.ts";
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
  // If it's a file path that exists, read it
  if (existsSync(input)) {
    return readFileSync(input, "utf8").trim();
  }
  return input;
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  const isInteractive = process.stdin.isTTY ?? false;

  console.error("");
  console.error("  Clawth Setup");
  console.error("  ────────────");
  console.error("");

  // ── Resolve agent, remote, jwt from flags → env → defaults ──

  const agent =
    opts.agent ??
    process.env.CLAWTH_AGENT_ID ??
    "default";

  const remote =
    opts.remote ??
    process.env.CLAWTH_REMOTE ??
    undefined;

  let remoteJwt: string | undefined;
  const rawJwt = opts.remoteJwt ?? process.env.CLAWTH_REMOTE_JWT;
  if (rawJwt) {
    remoteJwt = resolveJwtValue(rawJwt);
  }

  if (remote && !remoteJwt) {
    console.error("  --remote-jwt is required when using --remote.");
    process.exit(1);
  }

  // Apply agent & remote config NOW so DB operations use them
  setAgentId(agent);
  if (remote && remoteJwt) {
    configurePostgREST({ baseUrl: remote, jwt: remoteJwt });
  }

  console.error(`  Agent:  ${agent}`);
  if (remote) {
    console.error(`  Remote: ${remote}`);
  }

  // ── Step 1: Persist config ──

  const cfg: ClawthConfig = { agent };
  if (remote) cfg.remote = remote;
  if (remoteJwt) cfg.remoteJwt = remoteJwt;
  saveConfig(cfg);
  console.error("  Config saved.");

  // ── Step 2: Initialize database & register passphrase ──

  const path = dbPath();
  let passphrase = opts.passphrase ?? process.env.CLAWTH_AGENT_PASSPHRASE ?? "";
  let needsInit = true;

  // For local mode, check if DB file exists
  if (!remote) {
    if (existsSync(path)) {
      if (isInteractive && !passphrase) {
        const reinit = await promptConfirm(
          `  Database already exists at ${path}. Reinitialize?`,
        );
        if (!reinit) {
          console.error("  Keeping existing database.");
          needsInit = false;
          passphrase = await promptSecret("  Passphrase (to start session): ");
        } else {
          unlinkSync(path);
        }
      } else {
        // Non-interactive with existing DB — just register the agent's passphrase
        needsInit = false;
        await initializeDatabase();
      }
    }
  } else {
    // Remote mode — no local DB init needed, just register passphrase
    needsInit = false;
  }

  if (needsInit) {
    await initializeDatabase();
  }

  // Resolve passphrase: provided → env → interactive → auto-generate
  if (!passphrase) {
    if (isInteractive) {
      console.error("  Set your passphrase (encrypts all stored credentials):");
      while (true) {
        passphrase = await promptSecret("  Passphrase: ");
        if (!passphrase) {
          console.error("  Passphrase cannot be empty.");
          continue;
        }
        const confirm = await promptSecret("  Confirm:    ");
        if (passphrase !== confirm) {
          console.error("  Passphrases do not match. Try again.");
          continue;
        }
        break;
      }
    } else {
      passphrase = generatePassphrase();
      console.error(`  Generated passphrase (save this): ${passphrase}`);
    }
  }

  // Store passphrase hash for this agent
  const { hash, salt } = hashPassphrase(passphrase);
  await setMeta(passphraseHashKey(), hash);
  await setMeta(passphraseSaltKey(), salt);
  await setMeta("version", "1");

  if (remote) {
    console.error(`  Passphrase registered for agent '${agent}' (remote).`);
  } else {
    console.error(`  Database initialized at ${path}`);
    console.error(`  Passphrase registered for agent '${agent}'.`);
  }

  // ── Step 3: Install Claude Code skill ──
  if (!opts.noSkill) {
    let installSkill = true;
    if (isInteractive && !opts.passphrase && !opts.agent) {
      installSkill = await promptConfirm("  Install Claude Code /clawth skill?");
    }
    if (installSkill) {
      installClawthSkill(opts.skillDir);
    } else {
      console.error("  Skipping skill installation.");
    }
  }

  // ── Step 4: Start session daemon ──
  {
    let startDaemon = true;
    if (isInteractive && !opts.passphrase && !opts.agent) {
      startDaemon = await promptConfirm(
        "  Start session daemon? (caches passphrase for 4h)",
      );
    }
    if (startDaemon) {
      await spawnSessionDaemon(passphrase);
    }
  }

  // ── Summary ──
  printSummary(agent, !!remote);
}

async function spawnSessionDaemon(passphrase: string): Promise<void> {
  const socketPath = sessionSocketPath();

  if (existsSync(socketPath)) {
    const result = await sendToDaemon("ping");
    if (result.ok) {
      console.error("  Session daemon already running.");
      return;
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
      if (result.ok) {
        console.error("  Session daemon started (passphrase cached for 4h).");
        return;
      }
    }
  }

  console.error("  Warning: session daemon did not start. You can start it later with: clawth session start");
}

function installClawthSkill(customDir?: string): void {
  const skillDir = customDir ?? join(homedir(), ".claude", "skills", "clawth");
  mkdirSync(skillDir, { recursive: true });

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDir, "..", "..");
  const skillSource = join(projectRoot, "skill", "SKILL.md");

  if (!existsSync(skillSource)) {
    console.error("  Skill source not found. Skipping.");
    return;
  }

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
  console.error(`  Skill installed to ${skillDir}/SKILL.md`);
}

function printSummary(agent: string, isRemote: boolean): void {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(thisDir, "..", "..");
  const clawthBin = join(projectRoot, "bin", "clawth.ts");
  const run = `bun run ${clawthBin}`;

  console.error("");
  console.error("  Setup complete!");
  console.error(`  Agent: ${agent}${isRemote ? " (remote)" : " (local)"}`);
  console.error("");
  console.error("  Quick start:");
  console.error(
    `    ${run} set github --type bearer --header Authorization --pattern '*.github.com'`,
  );
  console.error(`    ${run} curl https://api.github.com/user`);
  console.error(`    ${run} list`);
  console.error("");
  console.error("  In Claude Code, use /clawth to make authenticated API calls.");
  console.error("");
}
