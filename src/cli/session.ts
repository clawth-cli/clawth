import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionSocketPath } from "../config/paths.ts";
import { sendToDaemon, getPassphrase } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { getAgentId } from "../db/repository.ts";

export async function sessionCommand(action: string): Promise<void> {
  if (action === "start") {
    await startSession();
  } else if (action === "stop") {
    await stopSession();
  } else {
    console.error(`Unknown session action: ${action}. Use 'start' or 'stop'.`);
    process.exit(1);
  }
}

function findDaemonScript(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "session", "daemon.ts");
}

async function startSession(): Promise<void> {
  const socketPath = sessionSocketPath();
  if (existsSync(socketPath)) {
    const result = await sendToDaemon("ping");
    if (result.ok) {
      console.error("Session daemon is already running.");
      return;
    }
  }

  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  const daemonScript = findDaemonScript();
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

  // Wait for the daemon to bind the socket
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (existsSync(socketPath)) {
      const result = await sendToDaemon("ping");
      if (result.ok) {
        console.error("Session daemon started. Passphrase cached for 4h.");
        return;
      }
    }
  }

  console.error("Failed to start session daemon.");
  process.exit(1);
}

async function stopSession(): Promise<void> {
  const result = await sendToDaemon("stop");
  if (result.ok) {
    console.error("Session daemon stopped.");
  } else {
    console.error(`Failed to stop daemon: ${result.message ?? "not running"}`);
  }
}
