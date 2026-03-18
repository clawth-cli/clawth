import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue } from "../../db/repository.ts";

export const basicStrategy: AuthStrategy = {
  type: "basic",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    // Secret is stored as "user:pass"
    const encoded = Buffer.from(secret).toString("base64");

    return {
      headers: { Authorization: `Basic ${encoded}` },
    };
  },
};
