import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { dbPath, ensureDir, dataDir } from "../config/paths.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as schema from "./schema.ts";

let sqlJsDb: SqlJsDatabase | null = null;
let drizzleDb: SqliteRemoteDatabase<typeof schema> | null = null;
let currentDbPath: string | null = null;

function saveToDisk(): void {
  if (sqlJsDb && currentDbPath) {
    const data = sqlJsDb.export();
    writeFileSync(currentDbPath, Buffer.from(data));
  }
}

function queryWithPreparedStatement(
  db: SqlJsDatabase,
  sql: string,
  params: unknown[],
  method: string,
): { rows: unknown[][] } {
  const stmt = db.prepare(sql);

  if (params.length > 0) {
    stmt.bind(params as (string | number | null | Uint8Array)[]);
  }

  if (method === "run") {
    stmt.step();
    stmt.free();
    saveToDisk();
    return { rows: [] };
  }

  // Drizzle sqlite-proxy expects rows as arrays of values (tuples)
  const rows: unknown[][] = [];

  while (stmt.step()) {
    rows.push(stmt.get());
    if (method === "get") break;
  }

  stmt.free();
  return { rows };
}

export async function getDb(
  customPath?: string,
): Promise<SqliteRemoteDatabase<typeof schema>> {
  if (drizzleDb) return drizzleDb;

  // Reuse existing sql.js instance if initializeDatabase was called
  if (!sqlJsDb) {
    const SQL = await initSqlJs();
    const path = customPath ?? dbPath();
    currentDbPath = path;

    if (existsSync(path)) {
      const fileBuffer = readFileSync(path);
      sqlJsDb = new SQL.Database(fileBuffer);
    } else {
      sqlJsDb = new SQL.Database();
    }

    sqlJsDb.run("PRAGMA foreign_keys = ON;");
  }

  const db = sqlJsDb;

  drizzleDb = drizzle<typeof schema>(
    async (sql, params, method) => {
      return queryWithPreparedStatement(db, sql, params as unknown[], method);
    },
    { schema },
  );

  return drizzleDb;
}

export async function initializeDatabase(customPath?: string): Promise<void> {
  const path = customPath ?? dbPath();
  ensureDir(dataDir());

  const SQL = await initSqlJs();
  currentDbPath = path;

  if (existsSync(path)) {
    const fileBuffer = readFileSync(path);
    sqlJsDb = new SQL.Database(fileBuffer);
  } else {
    sqlJsDb = new SQL.Database();
  }

  sqlJsDb.run("PRAGMA foreign_keys = ON;");

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'default',
      service TEXT NOT NULL,
      type TEXT NOT NULL,
      inject_method TEXT NOT NULL DEFAULT 'header',
      inject_name TEXT NOT NULL,
      inject_template TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, service)
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS url_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS oauth_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      token_url TEXT NOT NULL,
      authorize_url TEXT,
      encrypted_client_id TEXT NOT NULL,
      client_id_iv TEXT NOT NULL,
      client_id_auth_tag TEXT NOT NULL,
      client_id_salt TEXT NOT NULL,
      encrypted_client_secret TEXT,
      client_secret_iv TEXT,
      client_secret_auth_tag TEXT,
      client_secret_salt TEXT,
      scopes TEXT,
      use_pkce INTEGER NOT NULL DEFAULT 0,
      encrypted_access_token TEXT,
      access_token_iv TEXT,
      access_token_auth_tag TEXT,
      access_token_salt TEXT,
      encrypted_refresh_token TEXT,
      refresh_token_iv TEXT,
      refresh_token_auth_tag TEXT,
      refresh_token_salt TEXT,
      expires_at INTEGER
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS jwt_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      algorithm TEXT NOT NULL DEFAULT 'RS256',
      issuer TEXT,
      audience TEXT,
      expiry_seconds INTEGER NOT NULL DEFAULT 3600,
      custom_claims TEXT
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS aws_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      region TEXT NOT NULL,
      aws_service TEXT NOT NULL,
      encrypted_session_token TEXT,
      session_token_iv TEXT,
      session_token_auth_tag TEXT,
      session_token_salt TEXT
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  sqlJsDb.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      service TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER,
      timestamp INTEGER NOT NULL
    );
  `);

  saveToDisk();

  // Reset cached drizzle instance so getDb picks up the new sqlJsDb
  drizzleDb = null;
}

export function closeDatabase(): void {
  if (sqlJsDb) {
    saveToDisk();
    sqlJsDb.close();
    sqlJsDb = null;
    drizzleDb = null;
    currentDbPath = null;
  }
}
