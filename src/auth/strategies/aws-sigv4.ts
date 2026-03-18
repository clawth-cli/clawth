import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue, getAwsMetadata } from "../../db/repository.ts";
import { decrypt } from "../../crypto/encryption.ts";
import { signAwsSigV4 } from "../../crypto/aws-sigv4.ts";

export const awsSigV4Strategy: AuthStrategy = {
  type: "aws_sigv4",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    const meta = await getAwsMetadata(ctx.credentialId);
    if (!meta) throw new Error(`AWS metadata not found for: ${ctx.service}`);

    // Secret format: access_key_id:secret_access_key
    const [accessKeyId, secretAccessKey] = secret.split(":");
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(`Invalid AWS credential format for ${ctx.service}. Expected "access_key_id:secret_access_key"`);
    }

    let sessionToken: string | undefined;
    if (meta.encryptedSessionToken) {
      const aad = `${ctx.agentId}:${ctx.service}:aws`;
      sessionToken = await decrypt(
        {
          ciphertext: meta.encryptedSessionToken,
          iv: meta.sessionTokenIv!,
          authTag: meta.sessionTokenAuthTag!,
          salt: meta.sessionTokenSalt!,
        },
        ctx.passphrase,
        aad,
      );
    }

    const result = signAwsSigV4({
      method: ctx.method,
      url: ctx.url,
      headers: ctx.requestHeaders,
      body: ctx.body ?? "",
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region: meta.region,
      service: meta.awsService,
    });

    return { headers: result.headers };
  },
};
