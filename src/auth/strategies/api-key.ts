import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue, getCredentialByService } from "../../db/repository.ts";

export const apiKeyStrategy: AuthStrategy = {
  type: "api_key",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const cred = await getCredentialByService(ctx.service);
    if (!cred) throw new Error(`Credential not found: ${ctx.service}`);

    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    const value = cred.injectTemplate.replace("{token}", secret);

    if (cred.injectMethod === "query_param") {
      return { queryParams: { [cred.injectName]: value } };
    }

    return { headers: { [cred.injectName]: value } };
  },
};
