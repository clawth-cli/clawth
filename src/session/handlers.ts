import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { deriveKey } from "../crypto/kdf.ts";
import { resolveServiceForUrl, resolveAuth } from "../auth/resolver.ts";
import { getCredentialByService, getAgentId } from "../db/repository.ts";
import { logAudit } from "../db/audit.ts";
import { parseCurlArgs } from "../curl/parser.ts";
import { injectAuth } from "../curl/injector.ts";
import { cleanupTempCert } from "../auth/strategies/mtls.ts";
import { DAEMON_PROTOCOL_VERSION } from "./client.ts";

// ── Key cache (Phase 1) ──

const keyCache = new Map<string, string>(); // salt_base64 → key_base64

// ── OAuth mutex (Phase 4) ──

const serviceMutexes = new Map<string, Promise<void>>();

function withServiceMutex<T>(service: string, fn: () => Promise<T>): Promise<T> {
  const prev = serviceMutexes.get(service) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  serviceMutexes.set(service, next.then(() => {}, () => {}));
  return next;
}

// ── Handler dispatch ──

export interface DaemonState {
  passphrase: string;
}

export async function handleRequest(
  conn: Socket,
  msg: Record<string, unknown>,
  state: DaemonState,
): Promise<void> {
  const action = msg.action as string;

  switch (action) {
    case "get":
      respond(conn, { passphrase: state.passphrase });
      break;

    case "ping":
      respond(conn, { ok: true, version: DAEMON_PROTOCOL_VERSION });
      break;

    case "stop":
      respond(conn, { ok: true, message: "Stopping" });
      return; // Caller handles shutdown

    case "derive-key":
      handleDeriveKey(conn, msg, state);
      break;

    case "resolve-service":
      await handleResolveService(conn, msg);
      break;

    case "get-credential":
      await handleGetCredential(conn, msg);
      break;

    case "resolve-auth":
      await handleResolveAuth(conn, msg, state);
      break;

    case "log-audit":
      await handleLogAudit(conn, msg);
      break;

    case "reload-db": {
      // Re-initialize database from disk
      const { closeDatabase, initializeDatabase } = await import("../db/connection.ts");
      closeDatabase();
      await initializeDatabase();
      respond(conn, { ok: true });
      break;
    }

    case "curl":
      await handleCurl(conn, msg, state);
      return; // Don't end connection — streaming handles it

    default:
      respond(conn, { error: "Unknown action" });
  }
}

function respond(conn: Socket, data: Record<string, unknown>): void {
  conn.end(JSON.stringify(data) + "\n");
}

function streamLine(conn: Socket, data: Record<string, unknown>): void {
  conn.write(JSON.stringify(data) + "\n");
}

// ── Handlers ──

function handleDeriveKey(
  conn: Socket,
  msg: Record<string, unknown>,
  state: DaemonState,
): void {
  const salt = msg.salt as string;
  if (!salt) {
    respond(conn, { ok: false, error: "Missing salt" });
    return;
  }

  let keyBase64 = keyCache.get(salt);
  if (!keyBase64) {
    const key = deriveKey(state.passphrase, Buffer.from(salt, "base64"));
    keyBase64 = key.toString("base64");
    keyCache.set(salt, keyBase64);
  }

  respond(conn, { ok: true, key: keyBase64 });
}

async function handleResolveService(
  conn: Socket,
  msg: Record<string, unknown>,
): Promise<void> {
  const url = msg.url as string;
  if (!url) {
    respond(conn, { ok: false, error: "Missing url" });
    return;
  }

  const service = await resolveServiceForUrl(url);
  respond(conn, { ok: true, service });
}

async function handleGetCredential(
  conn: Socket,
  msg: Record<string, unknown>,
): Promise<void> {
  const service = msg.service as string;
  if (!service) {
    respond(conn, { ok: false, error: "Missing service" });
    return;
  }

  const credential = await getCredentialByService(service);
  respond(conn, { ok: true, credential });
}

async function handleResolveAuth(
  conn: Socket,
  msg: Record<string, unknown>,
  state: DaemonState,
): Promise<void> {
  const service = msg.service as string;
  if (!service) {
    respond(conn, { ok: false, error: "Missing service" });
    return;
  }

  const cred = await getCredentialByService(service);
  if (!cred) {
    respond(conn, { ok: false, error: `Credential not found: ${service}` });
    return;
  }

  try {
    const result = await withServiceMutex(service, () =>
      resolveAuth({
        agentId: getAgentId(),
        service,
        passphrase: state.passphrase,
        credentialId: cred.id,
        url: msg.url as string,
        method: msg.method as string,
        requestHeaders: (msg.headers as Record<string, string>) ?? {},
        body: msg.body as string | undefined,
      }),
    );

    respond(conn, {
      ok: true,
      headers: result.headers,
      queryParams: result.queryParams,
      curlExtraArgs: result.curlExtraArgs,
    });
  } catch (err) {
    respond(conn, { ok: false, message: (err as Error).message });
  }
}

async function handleLogAudit(
  conn: Socket,
  msg: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    service: msg.service as string,
    url: msg.url as string,
    method: msg.method as string,
    statusCode: (msg.statusCode as number) ?? null,
  });
  respond(conn, { ok: true });
}

// ── Phase 4: Streaming curl handler ──

async function handleCurl(
  conn: Socket,
  msg: Record<string, unknown>,
  state: DaemonState,
): Promise<void> {
  const args = msg.args as string[];
  let service = msg.service as string | undefined;

  try {
    const parsed = parseCurlArgs(args);

    // Resolve service
    if (!service) {
      service = (await resolveServiceForUrl(parsed.url)) ?? undefined;
    }

    if (!service) {
      // Send structured error for CLI to handle interactively
      const hostname = new URL(parsed.url).hostname;
      const parts = hostname.split(".");
      const suggestedService = parts.length >= 3 ? parts[parts.length - 2]! : parts[0]!;
      const suggestedPattern = parts.length >= 3 ? `*.${parts.slice(-2).join(".")}` : hostname;

      streamLine(conn, {
        type: "error",
        message: "CLAWTH_NO_CREDENTIAL",
        code: 2,
        url: parsed.url,
        suggestedService,
        suggestedPattern,
      });
      conn.end();
      return;
    }

    const cred = await getCredentialByService(service);
    if (!cred) {
      streamLine(conn, { type: "error", message: `Credential '${service}' not found.`, code: 1 });
      conn.end();
      return;
    }

    // Resolve auth (with mutex for OAuth refresh)
    const authResult = await withServiceMutex(service, () =>
      resolveAuth({
        agentId: getAgentId(),
        service: service!,
        passphrase: state.passphrase,
        credentialId: cred.id,
        url: parsed.url,
        method: parsed.method,
        requestHeaders: parsed.headers,
        body: parsed.body,
      }),
    );

    const tempCertPath = authResult.headers?.["X-Clawth-Temp-Cert"];
    const injected = injectAuth(parsed.url, authResult, parsed.remainingArgs);

    // Build curl command
    const curlArgs: string[] = ["--config", "-"];

    for (const [name, value] of Object.entries(parsed.headers)) {
      curlArgs.push("-H", `${name}: ${value}`);
    }

    curlArgs.push(...injected.extraArgs);
    curlArgs.push(...parsed.remainingArgs);
    curlArgs.push(injected.url);

    // Spawn curl and stream output
    const proc = spawn("curl", curlArgs, { stdio: ["pipe", "pipe", "pipe"] });

    proc.stdout.on("data", (data: Buffer) => {
      streamLine(conn, { type: "stdout", data: data.toString("base64") });
    });

    proc.stderr.on("data", (data: Buffer) => {
      streamLine(conn, { type: "stderr", data: data.toString("base64") });
    });

    // Write config lines to stdin
    if (injected.configLines.length > 0) {
      proc.stdin.write(injected.configLines.join("\n") + "\n");
    }
    proc.stdin.end();

    proc.on("error", (err) => {
      streamLine(conn, { type: "error", message: `Failed to spawn curl: ${err.message}`, code: 1 });
      conn.end();
    });

    const finalService = service;

    proc.on("close", async (code) => {
      // Detect auth failure from stderr
      // We need to reconstruct stderr to check for status codes
      // The proc.stderr data events have already been streamed, but we can check the exit
      // We'll do a best-effort status code parse from accumulated stderr
      const exitCode = code ?? 1;

      // Audit log (best-effort)
      try {
        await logAudit({
          service: finalService,
          url: parsed.url,
          method: parsed.method,
          statusCode: null, // Status not easily available in streaming mode
        });
      } catch {
        // Best-effort
      }

      // Cleanup temp cert
      if (tempCertPath) {
        cleanupTempCert(tempCertPath);
      }

      streamLine(conn, { type: "exit", code: exitCode });
      conn.end();
    });
  } catch (err) {
    streamLine(conn, { type: "error", message: (err as Error).message, code: 1 });
    conn.end();
  }
}
