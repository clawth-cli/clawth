import { createServer } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { sessionSocketPath, runtimeDir, ensureDir } from "../config/paths.ts";
import { handleRequest, type DaemonState } from "./handlers.ts";

const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function startDaemon(passphrase: string): Promise<void> {
  const socketPath = sessionSocketPath();
  ensureDir(runtimeDir());

  // Remove stale socket
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }

  // Phase 3: Initialize DB in daemon process
  const { initializeDatabase } = await import("../db/connection.ts");
  const { setAgentId } = await import("../db/repository.ts");

  const agentId = process.env.CLAWTH_AGENT_ID ?? "default";
  setAgentId(agentId);
  await initializeDatabase();

  const state: DaemonState = { passphrase };

  let idleTimer: ReturnType<typeof setTimeout>;

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error("Session expired after 4h idle. Shutting down.");
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {}
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  }

  const server = createServer((conn) => {
    resetIdle();

    let data = "";
    conn.on("data", (chunk) => {
      data += chunk.toString();

      // Respond as soon as we receive a complete newline-terminated message
      if (!data.includes("\n")) return;

      const msgStr = data;
      data = ""; // Reset for potential subsequent messages on same connection

      try {
        const msg = JSON.parse(msgStr.trim()) as Record<string, unknown>;

        handleRequest(conn, msg, state).then(() => {
          // Check if stop was requested
          if (msg.action === "stop") {
            server.close();
            try {
              unlinkSync(socketPath);
            } catch {}
            process.exit(0);
          }
        }).catch((err) => {
          try {
            conn.end(JSON.stringify({ error: (err as Error).message }) + "\n");
          } catch {
            // Connection may already be closed
          }
        });
      } catch {
        conn.end(JSON.stringify({ error: "Invalid request" }) + "\n");
      }
    });
  });

  server.listen(socketPath, () => {
    console.error(`Session daemon started on ${socketPath}`);
    console.error(`Agent: ${agentId}`);
    console.error("Passphrase cached. Will expire after 4h idle.");
    resetIdle();
  });

  server.on("error", (err) => {
    console.error(`Daemon error: ${err.message}`);
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });

  process.on("SIGINT", () => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });
}

// ── Standalone entry point for spawning as a detached process ──
if (import.meta.main) {
  const passphrase = process.env.CLAWTH_DAEMON_PASSPHRASE;
  if (!passphrase) {
    console.error("CLAWTH_DAEMON_PASSPHRASE env var is required");
    process.exit(1);
  }
  startDaemon(passphrase);
}
