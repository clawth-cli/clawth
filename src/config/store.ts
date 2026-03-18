import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, dataDir, ensureDir } from "./paths.ts";

export interface ClawthConfig {
  agent: string;
  remote?: string;
  remoteJwt?: string;
}

const DEFAULT_AGENT = "default";

/**
 * Load persisted config from disk, with env-var overrides.
 *
 * Priority (highest wins):
 *   1. Environment variables (CLAWTH_AGENT_ID, CLAWTH_REMOTE, CLAWTH_REMOTE_JWT)
 *   2. Config file (~/.local/share/clawth/config.json)
 *   3. Defaults
 */
export function loadConfig(): ClawthConfig {
  let file: Partial<ClawthConfig> = {};

  const path = configPath();
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupted config — fall through to defaults
    }
  }

  return {
    agent: process.env.CLAWTH_AGENT_ID ?? file.agent ?? DEFAULT_AGENT,
    remote: process.env.CLAWTH_REMOTE ?? file.remote,
    remoteJwt: resolveJwt(process.env.CLAWTH_REMOTE_JWT ?? file.remoteJwt),
  };
}

export function saveConfig(cfg: ClawthConfig): void {
  ensureDir(dataDir());
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * If the value looks like a file path (ends with .json, .jwt, .txt, or
 * exists on disk), read the JWT from the file. Otherwise treat as raw JWT.
 */
function resolveJwt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (
    value.startsWith("eyJ") || // Already a raw JWT
    value.includes(".") === false // No extension, treat as raw
  ) {
    // But also check if it's a file that exists
    if (existsSync(value)) {
      return readFileSync(value, "utf8").trim();
    }
    return value;
  }
  // Looks like a file path
  if (existsSync(value)) {
    return readFileSync(value, "utf8").trim();
  }
  // Not a file — treat as raw JWT
  return value;
}
