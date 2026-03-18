import type { CredentialType } from "../auth/types.ts";
import {
  createCredential,
  createOAuthMetadata,
  createJwtMetadata,
  createAwsMetadata,
  getCredentialByService,
  deleteCredential,
  updateCredentialSecret,
} from "../db/repository.ts";
import { getPassphrase, sendToDaemon } from "../session/client.ts";
import { verifyStoredPassphrase } from "./shared.ts";
import { promptSecret } from "../utils/prompt.ts";

interface SetOptions {
  type: CredentialType;
  header?: string;
  queryParam?: string;
  pattern?: string[];
  template?: string;
  secret?: string;
  // OAuth options
  tokenUrl?: string;
  authorizeUrl?: string;
  clientId?: string;
  scopes?: string;
  // JWT options
  algorithm?: string;
  issuer?: string;
  audience?: string;
  expirySeconds?: string;
  customClaims?: string;
  // AWS options
  region?: string;
  awsService?: string;
  sessionToken?: string;
}

const DEFAULT_TEMPLATES: Record<string, string> = {
  bearer: "Bearer {token}",
  api_key: "{token}",
  basic: "Basic {token}",
  oauth2: "Bearer {token}",
  oauth2_pkce: "Bearer {token}",
  jwt: "Bearer {token}",
  service_account: "Bearer {token}",
  aws_sigv4: "{token}",
  p12: "{token}",
};

export async function setCommand(
  service: string,
  opts: SetOptions,
): Promise<void> {
  const passphrase = await getPassphrase();
  await verifyStoredPassphrase(passphrase);

  // If service already exists: update secret only (if --secret provided) or replace entirely
  const existing = await getCredentialByService(service);
  if (existing) {
    // Shortcut: if only the secret is changing, just re-encrypt
    const secretOnly =
      opts.secret &&
      !opts.pattern?.length &&
      !opts.header &&
      !opts.queryParam &&
      !opts.template;

    if (secretOnly) {
      await updateCredentialSecret(service, opts.secret!, passphrase);
      console.error(`Credential '${service}' updated.`);
      return;
    }

    // Full replace: delete old + create new
    await deleteCredential(service);
    console.error(`Replacing existing credential '${service}'.`);
  }

  // Determine injection method
  let injectMethod: "header" | "query_param" = "header";
  let injectName = "Authorization";

  if (opts.queryParam) {
    injectMethod = "query_param";
    injectName = opts.queryParam;
  } else if (opts.header) {
    injectName = opts.header;
  }

  const injectTemplate = opts.template ?? DEFAULT_TEMPLATES[opts.type] ?? "{token}";
  const patterns = opts.pattern ?? [];

  // Resolve secret: --secret flag → piped stdin → interactive prompt
  let secret: string;
  if (opts.type === "oauth2_pkce") {
    secret = "pkce_placeholder";
  } else if (opts.secret) {
    secret = opts.secret;
  } else {
    secret = await promptSecret("Secret value: ");
    if (!secret) {
      console.error("Secret cannot be empty.");
      process.exit(1);
    }
  }

  const credentialId = await createCredential({
    service,
    type: opts.type,
    injectMethod,
    injectName,
    injectTemplate,
    secret,
    passphrase,
    patterns,
  });

  // Create type-specific metadata
  if (opts.type === "oauth2" || opts.type === "oauth2_pkce") {
    if (!opts.tokenUrl) {
      console.error("--token-url is required for OAuth2 credentials.");
      process.exit(1);
    }

    let clientId = opts.clientId;
    if (!clientId) {
      clientId = await promptSecret("Client ID: ");
    }

    let clientSecret: string | undefined;
    if (opts.type === "oauth2") {
      clientSecret = await promptSecret("Client Secret: ");
    }

    await createOAuthMetadata({
      credentialId,
      tokenUrl: opts.tokenUrl,
      authorizeUrl: opts.authorizeUrl,
      clientId: clientId!,
      clientSecret,
      scopes: opts.scopes,
      usePkce: opts.type === "oauth2_pkce",
      passphrase,
      service,
    });
  }

  if (opts.type === "jwt") {
    await createJwtMetadata({
      credentialId,
      algorithm: opts.algorithm ?? "RS256",
      issuer: opts.issuer,
      audience: opts.audience,
      expirySeconds: parseInt(opts.expirySeconds ?? "3600", 10),
      customClaims: opts.customClaims,
    });
  }

  if (opts.type === "aws_sigv4") {
    if (!opts.region || !opts.awsService) {
      console.error("--region and --aws-service are required for AWS SigV4 credentials.");
      process.exit(1);
    }

    await createAwsMetadata({
      credentialId,
      region: opts.region,
      awsService: opts.awsService,
      sessionToken: opts.sessionToken,
      passphrase,
      service,
    });
  }

  // Notify daemon to reload DB (best-effort)
  try {
    await sendToDaemon("reload-db");
  } catch {
    // Daemon may not be running
  }

  console.error(`Credential '${service}' stored (type: ${opts.type}).`);
  if (patterns.length > 0) {
    console.error(`URL patterns: ${patterns.join(", ")}`);
  }
}
