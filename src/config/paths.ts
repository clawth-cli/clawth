import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

function env(key: string): string | undefined {
  return process.env[key];
}

export function dataDir(): string {
  const base =
    env("CLAWTH_DATA_DIR") ??
    env("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  return join(base, "clawth");
}

export function runtimeDir(): string {
  const base =
    env("CLAWTH_RUNTIME_DIR") ??
    env("XDG_RUNTIME_DIR") ??
    join(homedir(), ".local", "run");
  return join(base, "clawth");
}

export function dbPath(): string {
  return join(dataDir(), "clawth.db");
}

export function sessionSocketPath(): string {
  return join(runtimeDir(), "session.sock");
}

export function configPath(): string {
  return join(dataDir(), "config.json");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
