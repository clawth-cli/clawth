import picomatch from "picomatch";
import type { AuthStrategy, AuthContext, AuthResult, CredentialType } from "./types.ts";
import { getAllUrlPatterns, getCredentialByService } from "../db/repository.ts";
import { apiKeyStrategy } from "./strategies/api-key.ts";
import { bearerStrategy } from "./strategies/bearer.ts";
import { basicStrategy } from "./strategies/basic.ts";
import { jwtStrategy } from "./strategies/jwt-strategy.ts";
import { oauth2Strategy } from "./strategies/oauth2.ts";
import { oauth2PkceStrategy } from "./strategies/oauth2-pkce.ts";
import { serviceAccountStrategy } from "./strategies/service-account.ts";
import { awsSigV4Strategy } from "./strategies/aws-sigv4.ts";
import { mtlsStrategy } from "./strategies/mtls.ts";

const strategies: Record<string, AuthStrategy> = {
  api_key: apiKeyStrategy,
  bearer: bearerStrategy,
  basic: basicStrategy,
  jwt: jwtStrategy,
  oauth2: oauth2Strategy,
  oauth2_pkce: oauth2PkceStrategy,
  service_account: serviceAccountStrategy,
  aws_sigv4: awsSigV4Strategy,
  p12: mtlsStrategy,
};

export async function resolveServiceForUrl(url: string): Promise<string | null> {
  const patterns = await getAllUrlPatterns();
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;

  // Match patterns against hostname, sorted by priority (lower = higher priority)
  const matches = patterns
    .filter((p) => {
      const matcher = picomatch(p.pattern);
      return matcher(hostname) || matcher(url) || matcher(`${parsedUrl.hostname}${parsedUrl.pathname}`);
    })
    .sort((a, b) => a.priority - b.priority);

  if (matches.length === 0) return null;
  return matches[0]!.service;
}

export async function resolveAuth(ctx: AuthContext): Promise<AuthResult> {
  const cred = await getCredentialByService(ctx.service);
  if (!cred) throw new Error(`Credential not found: ${ctx.service}`);

  const strategy = strategies[cred.type];
  if (!strategy) throw new Error(`Unknown credential type: ${cred.type}`);

  return strategy.resolve({ ...ctx, credentialId: cred.id });
}
