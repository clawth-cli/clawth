import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { getCredentialByService, getOAuthMetadata, updateOAuthTokens } from "../../db/repository.ts";
import { decrypt, type EncryptedPayload } from "../../crypto/encryption.ts";

export const oauth2Strategy: AuthStrategy = {
  type: "oauth2",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    const cred = await getCredentialByService(ctx.service);
    if (!cred) throw new Error(`Credential not found: ${ctx.service}`);

    const meta = await getOAuthMetadata(cred.id);
    if (!meta) throw new Error(`OAuth metadata not found for: ${ctx.service}`);

    const aad = `${ctx.agentId}:${ctx.service}:oauth`;

    // Check if we have a cached access token that hasn't expired
    if (meta.encryptedAccessToken && meta.expiresAt) {
      const now = Math.floor(Date.now() / 1000);
      if (now < meta.expiresAt - 60) {
        // 60s buffer
        const accessToken = await decrypt(
          {
            ciphertext: meta.encryptedAccessToken,
            iv: meta.accessTokenIv!,
            authTag: meta.accessTokenAuthTag!,
            salt: meta.accessTokenSalt!,
          },
          ctx.passphrase,
          aad,
        );
        return { headers: { [cred.injectName]: cred.injectTemplate.replace("{token}", accessToken) } };
      }
    }

    // Need to refresh — decrypt refresh token
    if (!meta.encryptedRefreshToken) {
      throw new Error(
        `No refresh token available for ${ctx.service}. Run 'clawth login ${ctx.service}' first.`,
      );
    }

    const refreshToken = await decrypt(
      {
        ciphertext: meta.encryptedRefreshToken,
        iv: meta.refreshTokenIv!,
        authTag: meta.refreshTokenAuthTag!,
        salt: meta.refreshTokenSalt!,
      },
      ctx.passphrase,
      aad,
    );

    // Decrypt client credentials
    const clientId = await decrypt(
      {
        ciphertext: meta.encryptedClientId,
        iv: meta.clientIdIv,
        authTag: meta.clientIdAuthTag,
        salt: meta.clientIdSalt,
      },
      ctx.passphrase,
      aad,
    );

    let clientSecret: string | null = null;
    if (meta.encryptedClientSecret) {
      clientSecret = await decrypt(
        {
          ciphertext: meta.encryptedClientSecret,
          iv: meta.clientSecretIv!,
          authTag: meta.clientSecretAuthTag!,
          salt: meta.clientSecretSalt!,
        },
        ctx.passphrase,
        aad,
      );
    }

    // Refresh the token
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }

    const response = await fetch(meta.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${text}`);
    }

    const tokenResponse = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = tokenResponse.expires_in
      ? now + tokenResponse.expires_in
      : null;

    await updateOAuthTokens(
      cred.id,
      tokenResponse.access_token,
      tokenResponse.refresh_token ?? refreshToken,
      expiresAt,
      ctx.passphrase,
      ctx.service,
    );

    return {
      headers: {
        [cred.injectName]: cred.injectTemplate.replace("{token}", tokenResponse.access_token),
      },
    };
  },
};
