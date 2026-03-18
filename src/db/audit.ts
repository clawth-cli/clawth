import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "./connection.ts";
import { auditLog } from "./schema.ts";
import { isRemoteMode, pgInsert, pgSelect } from "./postgrest.ts";
import { getAgentId } from "./repository.ts";

export interface AuditEntry {
  service: string;
  url: string;
  method: string;
  statusCode: number | null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  const agentId = getAgentId();
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    if (isRemoteMode()) {
      await pgInsert("audit_log", {
        agent_id: agentId,
        service: entry.service,
        url: entry.url,
        method: entry.method,
        status_code: entry.statusCode,
        timestamp,
      });
    } else {
      const db = await getDb();
      await db.insert(auditLog).values({
        agentId,
        service: entry.service,
        url: entry.url,
        method: entry.method,
        statusCode: entry.statusCode,
        timestamp,
      });
    }
  } catch {
    // Best-effort — never break the main flow
  }
}

interface AuditRow {
  id: number;
  agentId: string;
  service: string;
  url: string;
  method: string;
  statusCode: number | null;
  timestamp: number;
}

export async function getRecentAuditEntries(limit: number): Promise<AuditRow[]> {
  const agentId = getAgentId();

  if (isRemoteMode()) {
    const rows = await pgSelect<{
      id: number;
      agent_id: string;
      service: string;
      url: string;
      method: string;
      status_code: number | null;
      timestamp: number;
    }>("audit_log", { agent_id: `eq.${agentId}` }, { limit, order: "timestamp.desc" });

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      service: r.service,
      url: r.url,
      method: r.method,
      statusCode: r.status_code,
      timestamp: r.timestamp,
    }));
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.agentId, agentId))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit);

  return rows;
}

export interface ServiceUsageSummary {
  service: string;
  totalCalls: number;
  lastUsed: number;
  errorCount: number;
}

export async function getServiceUsage(): Promise<ServiceUsageSummary[]> {
  const agentId = getAgentId();

  if (isRemoteMode()) {
    // PostgREST doesn't support GROUP BY natively — fetch all and aggregate in JS
    const rows = await pgSelect<{
      service: string;
      status_code: number | null;
      timestamp: number;
    }>("audit_log", { agent_id: `eq.${agentId}`, select: "service,status_code,timestamp" });

    const map = new Map<string, ServiceUsageSummary>();
    for (const r of rows) {
      const existing = map.get(r.service) ?? {
        service: r.service,
        totalCalls: 0,
        lastUsed: 0,
        errorCount: 0,
      };
      existing.totalCalls++;
      if (r.timestamp > existing.lastUsed) existing.lastUsed = r.timestamp;
      if (r.status_code && r.status_code >= 400) existing.errorCount++;
      map.set(r.service, existing);
    }
    return [...map.values()].sort((a, b) => b.totalCalls - a.totalCalls);
  }

  // Local: use drizzle with raw SQL for aggregation
  const db = await getDb();
  const allEntries = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.agentId, agentId));

  const map = new Map<string, ServiceUsageSummary>();
  for (const r of allEntries) {
    const existing = map.get(r.service) ?? {
      service: r.service,
      totalCalls: 0,
      lastUsed: 0,
      errorCount: 0,
    };
    existing.totalCalls++;
    if (r.timestamp > existing.lastUsed) existing.lastUsed = r.timestamp;
    if (r.statusCode && r.statusCode >= 400) existing.errorCount++;
    map.set(r.service, existing);
  }
  return [...map.values()].sort((a, b) => b.totalCalls - a.totalCalls);
}
