import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import type { AuthStrategy, AuthContext, AuthResult } from "../types.ts";
import { getCredentialByService, getOAuthMetadata, updateOAuthTokens, getAgentId } from "../../db/repository.ts";
import { decrypt } from "../../crypto/encryption.ts";

const DEFAULT_CALLBACK_PORT = 8976;

export const oauth2PkceStrategy: AuthStrategy = {
  type: "oauth2_pkce",

  async resolve(ctx: AuthContext): Promise<AuthResult> {
    // PKCE resolve is same as oauth2 resolve for cached/refresh flows
    const cred = await getCredentialByService(ctx.service);
    if (!cred) throw new Error(`Credential not found: ${ctx.service}`);

    const meta = await getOAuthMetadata(cred.id);
    if (!meta) throw new Error(`OAuth metadata not found for: ${ctx.service}`);

    const aad = `${ctx.agentId}:${ctx.service}:oauth`;

    // Check cached token
    if (meta.encryptedAccessToken && meta.expiresAt) {
      const now = Math.floor(Date.now() / 1000);
      if (now < meta.expiresAt - 60) {
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

    // Refresh if we have a refresh token
    if (meta.encryptedRefreshToken) {
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

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      });

      const response = await fetch(meta.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (response.ok) {
        const tokenResponse = (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };

        const now = Math.floor(Date.now() / 1000);
        const expiresAt = tokenResponse.expires_in ? now + tokenResponse.expires_in : null;

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
      }
    }

    throw new Error(
      `No valid tokens for ${ctx.service}. Run 'clawth login ${ctx.service}' to authenticate.`,
    );
  },
};

// ── PKCE Login Flow (used by `clawth login`) ──

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} '${url}'`);
}

export async function performPkceLogin(
  service: string,
  passphrase: string,
): Promise<void> {
  const cred = await getCredentialByService(service);
  if (!cred) throw new Error(`Credential not found: ${service}`);

  const meta = await getOAuthMetadata(cred.id);
  if (!meta) throw new Error(`OAuth metadata not found for: ${service}`);
  if (!meta.authorizeUrl) throw new Error(`No authorize URL configured for: ${service}`);

  const aad = `${getAgentId()}:${service}:oauth`;
  const clientId = await decrypt(
    {
      ciphertext: meta.encryptedClientId,
      iv: meta.clientIdIv,
      authTag: meta.clientIdAuthTag,
      salt: meta.clientIdSalt,
    },
    passphrase,
    aad,
  );

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const port = DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/callback`;

  const authCode = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>Authentication Failed</h1><p>${error}</p></body></html>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authentication Complete!</h1><p>You can close this tab.</p></body></html>",
          );
          server.close();
          resolve(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing code parameter");
        server.close();
        reject(new Error("Missing code parameter in callback"));
      }
    });

    server.listen(port, () => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      if (meta.scopes) {
        params.set("scope", meta.scopes);
      }

      const authUrl = `${meta.authorizeUrl}?${params.toString()}`;
      console.error(`Opening browser for authentication...`);
      console.error(`If the browser doesn't open, visit: ${authUrl}`);
      openBrowser(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const tokenResponse = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = tokenResponse.expires_in ? now + tokenResponse.expires_in : null;

  await updateOAuthTokens(
    cred.id,
    tokenResponse.access_token,
    tokenResponse.refresh_token ?? null,
    expiresAt,
    passphrase,
    service,
  );

  console.error(`Successfully authenticated with ${service}!`);
}
