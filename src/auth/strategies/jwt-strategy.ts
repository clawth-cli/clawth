import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue } from "../../db/repository.ts";
import { getJwtMetadata } from "../../db/repository.ts";
import { signJwt } from "../../crypto/jwt.ts";

export const jwtStrategy: AuthStrategy = {
  type: "jwt",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    const meta = await getJwtMetadata(ctx.credentialId);
    if (!meta) throw new Error(`JWT metadata not found for: ${ctx.service}`);

    const now = Math.floor(Date.now() / 1000);
    let customClaims: Record<string, unknown> = {};
    if (meta.customClaims) {
      customClaims = JSON.parse(meta.customClaims);
    }

    const payload = {
      ...customClaims,
      ...(meta.issuer && { iss: meta.issuer }),
      ...(meta.audience && { aud: meta.audience }),
      exp: now + meta.expirySeconds,
    };

    const algorithm = meta.algorithm as "RS256" | "HS256";
    const token = signJwt(payload, secret, algorithm);

    return {
      headers: { Authorization: `Bearer ${token}` },
    };
  },
};
