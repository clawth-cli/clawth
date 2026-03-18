import { spawn } from "node:child_process";
import type { InjectedCurl } from "./injector.ts";
import { cleanupTempCert } from "../auth/strategies/mtls.ts";

export interface CurlExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function executeCurl(
  injected: InjectedCurl,
  remainingArgs: string[],
  originalHeaders: Record<string, string>,
  tempCertPath?: string,
): Promise<CurlExecutionResult> {
  try {
    // Build curl command arguments
    const curlArgs: string[] = [
      "--config",
      "-", // Read config from stdin
    ];

    // Add original headers from the command line
    for (const [name, value] of Object.entries(originalHeaders)) {
      curlArgs.push("-H", `${name}: ${value}`);
    }

    // Add extra args from auth (e.g., --cert for mTLS)
    curlArgs.push(...injected.extraArgs);

    // Add remaining user-provided args
    curlArgs.push(...remainingArgs);

    // Add the URL last
    curlArgs.push(injected.url);

    return await new Promise<CurlExecutionResult>((resolve, reject) => {
      const proc = spawn("curl", curlArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Write config lines to stdin (secrets stay out of ps aux)
      if (injected.configLines.length > 0) {
        proc.stdin.write(injected.configLines.join("\n") + "\n");
      }
      proc.stdin.end();

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn curl: ${err.message}`));
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  } finally {
    // Cleanup temp cert if mTLS was used
    if (tempCertPath) {
      cleanupTempCert(tempCertPath);
    }
  }
}
