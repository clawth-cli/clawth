/**
 * PostgREST client for remote database access.
 *
 * PostgREST exposes a PostgreSQL database as a REST API.
 * All requests are authenticated with a JWT Bearer token.
 * The remote DB must have the same table schema as the local SQLite DB.
 */

export interface PostgRESTConfig {
  baseUrl: string; // e.g., "https://postgrest.example.com"
  jwt: string; // Bearer token for PostgREST auth
}

let config: PostgRESTConfig | null = null;

export function configurePostgREST(cfg: PostgRESTConfig): void {
  // Strip trailing slash
  config = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
}

export function getPostgRESTConfig(): PostgRESTConfig | null {
  return config;
}

export function isRemoteMode(): boolean {
  return config !== null;
}

// ── Generic PostgREST request helpers ──

function headers(): Record<string, string> {
  if (!config) throw new Error("PostgREST not configured");
  return {
    Authorization: `Bearer ${config.jwt}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };
}

function url(table: string, query?: string): string {
  if (!config) throw new Error("PostgREST not configured");
  return `${config.baseUrl}/${table}${query ? `?${query}` : ""}`;
}

export async function pgSelect<T>(
  table: string,
  filters: Record<string, string>,
  options?: { limit?: number; order?: string },
): Promise<T[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    params.set(key, value);
  }
  if (options?.limit) {
    params.set("limit", String(options.limit));
  }
  if (options?.order) {
    params.set("order", options.order);
  }

  const resp = await fetch(url(table, params.toString()), {
    method: "GET",
    headers: headers(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PostgREST SELECT ${table}: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<T[]>;
}

export async function pgInsert<T>(
  table: string,
  data: Record<string, unknown>,
): Promise<T[]> {
  const resp = await fetch(url(table), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PostgREST INSERT ${table}: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<T[]>;
}

export async function pgUpdate<T>(
  table: string,
  filters: Record<string, string>,
  data: Record<string, unknown>,
): Promise<T[]> {
  const params = new URLSearchParams(filters);

  const resp = await fetch(url(table, params.toString()), {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PostgREST UPDATE ${table}: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<T[]>;
}

export async function pgDelete(
  table: string,
  filters: Record<string, string>,
): Promise<void> {
  const params = new URLSearchParams(filters);

  const resp = await fetch(url(table, params.toString()), {
    method: "DELETE",
    headers: headers(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PostgREST DELETE ${table}: ${resp.status} ${text}`);
  }
}

export async function pgUpsert<T>(
  table: string,
  data: Record<string, unknown>,
  onConflict: string,
): Promise<T[]> {
  const resp = await fetch(url(table), {
    method: "POST",
    headers: {
      ...headers(),
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PostgREST UPSERT ${table}: ${resp.status} ${text}`);
  }

  return resp.json() as Promise<T[]>;
}
