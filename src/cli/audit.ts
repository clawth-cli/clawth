import { getRecentAuditEntries, getServiceUsage } from "../db/audit.ts";
import { ensureDbInitialized } from "./shared.ts";

interface AuditOptions {
  last?: string;
  usage?: boolean;
}

export async function auditCommand(opts: AuditOptions): Promise<void> {
  await ensureDbInitialized();

  if (opts.usage) {
    await showUsage();
    return;
  }

  const limit = parseInt(opts.last ?? "20", 10);
  await showRecent(limit);
}

async function showRecent(limit: number): Promise<void> {
  const entries = await getRecentAuditEntries(limit);

  if (entries.length === 0) {
    console.log("No audit entries.");
    return;
  }

  const maxService = Math.max(...entries.map((e) => e.service.length), 7);
  const maxMethod = Math.max(...entries.map((e) => e.method.length), 6);

  console.log(
    `${"TIME".padEnd(20)}  ${"SERVICE".padEnd(maxService)}  ${"METHOD".padEnd(maxMethod)}  STATUS  URL`,
  );
  console.log(
    `${"─".repeat(20)}  ${"─".repeat(maxService)}  ${"─".repeat(maxMethod)}  ${"─".repeat(6)}  ${"─".repeat(40)}`,
  );

  for (const e of entries) {
    const time = new Date(e.timestamp * 1000).toISOString().replace("T", " ").slice(0, 19);
    const status = e.statusCode != null ? String(e.statusCode) : "  -";
    console.log(
      `${time}  ${e.service.padEnd(maxService)}  ${e.method.padEnd(maxMethod)}  ${status.padStart(6)}  ${e.url}`,
    );
  }
}

async function showUsage(): Promise<void> {
  const usage = await getServiceUsage();

  if (usage.length === 0) {
    console.log("No usage data.");
    return;
  }

  const maxService = Math.max(...usage.map((u) => u.service.length), 7);

  console.log(
    `${"SERVICE".padEnd(maxService)}  ${"CALLS".padStart(7)}  ${"ERRORS".padStart(7)}  LAST USED`,
  );
  console.log(
    `${"─".repeat(maxService)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(20)}`,
  );

  for (const u of usage) {
    const lastUsed = new Date(u.lastUsed * 1000).toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `${u.service.padEnd(maxService)}  ${String(u.totalCalls).padStart(7)}  ${String(u.errorCount).padStart(7)}  ${lastUsed}`,
    );
  }
}
