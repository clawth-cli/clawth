import { createConnection } from "node:net";
import { sessionSocketPath } from "../config/paths.ts";
import { promptSecret } from "../utils/prompt.ts";
import type { AuthResult } from "../auth/types.ts";
import type { AuditEntry } from "../db/audit.ts";

const ENV_KEY = "CLAWTH_SESSION_KEY";

// ── Phase 2: Source tracking ──

export type PassphraseSource = "env" | "daemon" | "prompt";

export interface PassphraseResult {
  passphrase: string;
  source: PassphraseSource;
}

export async function getPassphraseWithSource(): Promise<PassphraseResult> {
  // 1. Try CLAWTH_AGENT_PASSPHRASE env var (raw passphrase)
  const rawPassphrase = process.env.CLAWTH_AGENT_PASSPHRASE;
  if (rawPassphrase) return { passphrase: rawPassphrase, source: "env" };

  // 2. Try CLAWTH_SESSION_KEY env var (base64-encoded passphrase)
  const envKey = process.env[ENV_KEY];
  if (envKey) {
    return {
      passphrase: Buffer.from(envKey, "base64").toString("utf8"),
      source: "env",
    };
  }

  // 3. Try session daemon
  try {
    const passphrase = await getFromDaemon();
    if (passphrase) return { passphrase, source: "daemon" };
  } catch {
    // Daemon not running, fall through
  }

  // 4. Interactive prompt
  return { passphrase: await promptSecret("Passphrase: "), source: "prompt" };
}

export async function getPassphrase(): Promise<string> {
  const { passphrase } = await getPassphraseWithSource();
  return passphrase;
}

async function getFromDaemon(): Promise<string | null> {
  return new Promise((resolve) => {
    const socketPath = sessionSocketPath();
    let resolved = false;
    const done = (val: string | null) => {
      if (resolved) return;
      resolved = true;
      client.destroy();
      resolve(val);
    };

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ action: "get" }) + "\n");
    });

    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        try {
          const response = JSON.parse(data.trim()) as { passphrase?: string };
          done(response.passphrase ?? null);
        } catch {
          done(null);
        }
      }
    });

    client.on("end", () => done(null));
    client.on("error", () => done(null));
    setTimeout(() => done(null), 2000);
  });
}

export async function sendToDaemon(
  action: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; [key: string]: unknown }> {
  const socketPath = sessionSocketPath();
  // Fast-fail if socket doesn't exist — avoids ENOENT error
  const { existsSync } = await import("node:fs");
  if (!existsSync(socketPath)) {
    return { ok: false, message: "Daemon not running" };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (val: { ok: boolean; message?: string }) => {
      if (resolved) return;
      resolved = true;
      client.destroy();
      resolve(val);
    };

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ action, ...payload }) + "\n");
    });

    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        try {
          done(JSON.parse(data.trim()));
        } catch {
          done({ ok: false, message: "Invalid response" });
        }
      }
    });

    client.on("end", () => done({ ok: false, message: "Connection closed" }));
    client.on("error", (err) => done({ ok: false, message: err.message }));
    setTimeout(() => done({ ok: false, message: "Timeout" }), 2000);
  });
}

// ── Phase 1: Daemon key derivation ──

export async function daemonDeriveKey(salt: string): Promise<string | null> {
  try {
    const result = await sendToDaemon("derive-key", { salt });
    if (result.ok && typeof result.key === "string") {
      return result.key;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Phase 3: Daemon query functions ──

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const result = await sendToDaemon("ping");
    return result.ok === true && (result.version === DAEMON_PROTOCOL_VERSION || !result.version);
  } catch {
    return false;
  }
}

export const DAEMON_PROTOCOL_VERSION = "2";

export async function daemonPingVersion(): Promise<string | null> {
  try {
    const result = await sendToDaemon("ping");
    if (result.ok) return (result.version as string) ?? "1";
    return null;
  } catch {
    return null;
  }
}

export async function daemonResolveService(url: string): Promise<string | null> {
  const result = await sendToDaemon("resolve-service", { url });
  if (result.ok && typeof result.service === "string") return result.service;
  return null;
}

export async function daemonResolveAuth(ctx: {
  service: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<AuthResult> {
  const result = await sendToDaemon("resolve-auth", ctx);
  if (!result.ok) throw new Error(result.message ?? "Failed to resolve auth via daemon");
  return {
    headers: result.headers as Record<string, string> | undefined,
    queryParams: result.queryParams as Record<string, string> | undefined,
    curlExtraArgs: result.curlExtraArgs as string[] | undefined,
  };
}

export async function daemonLogAudit(entry: AuditEntry): Promise<void> {
  try {
    await sendToDaemon("log-audit", entry as unknown as Record<string, unknown>);
  } catch {
    // Best-effort
  }
}

// ── Phase 4: Daemon curl streaming ──

export async function daemonCurl(args: string[], service?: string): Promise<never> {
  return new Promise((resolve, reject) => {
    const socketPath = sessionSocketPath();

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ action: "curl", args, service }) + "\n");
    });

    let buffer = "";

    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            type: string;
            data?: string;
            code?: number;
            message?: string;
            service?: string;
            status?: number;
          };

          if (msg.type === "stdout" && msg.data) {
            process.stdout.write(Buffer.from(msg.data, "base64"));
          } else if (msg.type === "stderr" && msg.data) {
            process.stderr.write(Buffer.from(msg.data, "base64"));
          } else if (msg.type === "auth-expired") {
            const isInteractive = process.stdin.isTTY ?? false;
            if (!isInteractive) {
              process.stderr.write(`\nCLAWTH_AUTH_EXPIRED\nservice=${msg.service}\nstatus=${msg.status}\n`);
            } else {
              process.stderr.write(`\nWarning: received HTTP ${msg.status} — credential '${msg.service}' may be expired.\n`);
            }
          } else if (msg.type === "exit") {
            process.exit(msg.code ?? 0);
          } else if (msg.type === "error") {
            process.stderr.write(`${msg.message}\n`);
            process.exit(msg.code ?? 1);
          }
        } catch {
          // Ignore malformed lines
        }
      }
    });

    client.on("end", () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer) as { type: string; code?: number; message?: string };
          if (msg.type === "exit") {
            process.exit(msg.code ?? 0);
          } else if (msg.type === "error") {
            process.stderr.write(`${msg.message}\n`);
            process.exit(msg.code ?? 1);
          }
        } catch {
          // ignore
        }
      }
      process.exit(1); // Unexpected disconnect
    });

    client.on("error", (err) => {
      reject(new Error(`Daemon connection failed: ${err.message}`));
    });

    // Only timeout on initial connect, not during streaming
    const connectTimeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Daemon connection timeout"));
    }, 2000);

    client.once("connect", () => {
      clearTimeout(connectTimeout);
    });
  });
}
