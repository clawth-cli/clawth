import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue } from "../../db/repository.ts";

export const mtlsStrategy: AuthStrategy = {
  type: "p12",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    // Secret is the base64-encoded P12 file content
    const p12Buffer = Buffer.from(secret, "base64");

    // Write to a temp file with restrictive permissions
    const tempDir = join(tmpdir(), `clawth-${randomBytes(8).toString("hex")}`);
    mkdirSync(tempDir, { mode: 0o700 });
    const certPath = join(tempDir, "cert.p12");
    writeFileSync(certPath, p12Buffer, { mode: 0o600 });

    // Return curl flags for mTLS — cleanup happens in the executor's finally block
    return {
      curlExtraArgs: [
        "--cert",
        certPath,
        "--cert-type",
        "P12",
      ],
      // Store the temp path so the executor can clean it up
      headers: { "X-Clawth-Temp-Cert": certPath },
    };
  },
};

export function cleanupTempCert(path: string): void {
  try {
    unlinkSync(path);
    // Try to remove the parent temp dir
    const dir = join(path, "..");
    unlinkSync(dir);
  } catch {
    // Best effort cleanup
  }
}
