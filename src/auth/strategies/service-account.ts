import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { decryptCredentialValue } from "../../db/repository.ts";
import { signJwt } from "../../crypto/jwt.ts";

export const serviceAccountStrategy: AuthStrategy = {
  type: "service_account",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const secret = await decryptCredentialValue(ctx.service, ctx.passphrase);
    if (!secret) throw new Error(`Failed to decrypt credential: ${ctx.service}`);

    // Parse service account JSON (like Google service account)
    const sa = JSON.parse(secret) as {
      client_email: string;
      private_key: string;
      token_uri: string;
    };

    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt(
      {
        iss: sa.client_email,
        sub: sa.client_email,
        aud: sa.token_uri,
        exp: now + 3600,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      },
      sa.private_key,
      "RS256",
    );

    // Exchange JWT for access token
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    const response = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Service account token exchange failed: ${response.status} ${text}`);
    }

    const tokenResponse = (await response.json()) as { access_token: string };

    return {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    };
  },
};
