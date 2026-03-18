import { existsSync } from "node:fs";
import { dbPath, sessionSocketPath, configPath } from "../config/paths.ts";
import { loadConfig } from "../config/store.ts";
import { listCredentials, getAgentId } from "../db/repository.ts";
import { sendToDaemon } from "../session/client.ts";
import { isRemoteMode } from "../db/postgrest.ts";
import { ensureDbInitialized } from "./shared.ts";

export async function statusCommand(): Promise<void> {
  const cfg = loadConfig();

  console.log("Clawth Status");
  console.log("─────────────");
  console.log("");

  // Config
  console.log(`Agent:     ${cfg.agent}`);
  console.log(`Config:    ${existsSync(configPath()) ? configPath() : "(not found)"}`);

  // Database
  if (cfg.remote) {
    console.log(`Database:  remote (${cfg.remote})`);
    console.log(`JWT:       ${cfg.remoteJwt ? "configured" : "missing"}`);
  } else {
    const path = dbPath();
    console.log(`Database:  ${existsSync(path) ? path : "(not initialized)"}`);
  }

  // Session daemon
  const socketPath = sessionSocketPath();
  let daemonStatus = "stopped";
  if (existsSync(socketPath)) {
    const result = await sendToDaemon("ping");
    daemonStatus = result.ok ? "running" : "stale socket";
  }
  console.log(`Session:   ${daemonStatus}`);

  // Credentials
  try {
    await ensureDbInitialized();
    const creds = await listCredentials();
    console.log(`Credentials: ${creds.length} stored for agent '${getAgentId()}'`);
    if (creds.length > 0) {
      console.log("");
      for (const c of creds) {
        console.log(`  ${c.service} (${c.type}) → ${c.patterns.join(", ") || "(no patterns)"}`);
      }
    }
  } catch {
    console.log("Credentials: (unable to read — run setup first)");
  }

  console.log("");
}
