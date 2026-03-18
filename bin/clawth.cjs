#!/usr/bin/env node

// Thin wrapper that delegates to bun for TypeScript execution.
// This file is the npm `bin` entry so `npm i -g clawth` registers the `clawth` command.

const { execFileSync } = require("child_process");
const { join } = require("path");

const script = join(__dirname, "clawth.ts");
const args = process.argv.slice(2);

// Try bun first (fast, native TS), fall back to npx tsx (Node + TS)
try {
  execFileSync("bun", ["run", script, ...args], { stdio: "inherit" });
} catch (e) {
  if (e.status != null) {
    process.exit(e.status);
  }
  // bun not found — try npx tsx
  try {
    execFileSync("npx", ["--yes", "tsx", script, ...args], { stdio: "inherit" });
  } catch (e2) {
    if (e2.status != null) {
      process.exit(e2.status);
    }
    console.error("clawth requires bun or Node.js with tsx. Install bun: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
}
