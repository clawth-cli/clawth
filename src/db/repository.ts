import { eq, and } from "drizzle-orm";
import { getDb } from "./connection.ts";
import {
  credentials,
  urlPatterns,
  oauthMetadata,
  jwtMetadata,
  awsMetadata,
  dbMeta,
} from "./schema.ts";
import { encrypt, decrypt, type EncryptedPayload } from "../crypto/encryption.ts";
import {
  isRemoteMode,
  pgSelect,
  pgInsert,
  pgUpdate,
  pgDelete,
  pgUpsert,
} from "./postgrest.ts";

// ── Global agent ID — set once at startup via CLI --agent flag ──

let currentAgentId = "default";

export function setAgentId(id: string): void {
  currentAgentId = id;
}

export function getAgentId(): string {
  return currentAgentId;
}

// ── PostgREST row types (snake_case as returned by PostgREST) ──

interface PgCredentialRow {
  id: number;
  agent_id: string;
  service: string;
  type: string;
  inject_method: string;
  inject_name: string;
  inject_template: string;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
  salt: string;
  created_at: number;
  updated_at: number;
}

interface PgUrlPatternRow {
  id: number;
  credential_id: number;
  pattern: string;
  priority: number;
}

interface PgMetaRow {
  key: string;
  value: string;
}

// ── db_meta ──

export async function getMeta(key: string): Promise<string | null> {
  if (isRemoteMode()) {
    const rows = await pgSelect<PgMetaRow>("db_meta", { key: `eq.${key}` }, { limit: 1 });
    return rows[0]?.value ?? null;
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(dbMeta)
    .where(eq(dbMeta.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  if (isRemoteMode()) {
    await pgUpsert("db_meta", { key, value }, "key");
    return;
  }

  const db = await getDb();
  const existing = await getMeta(key);
  if (existing !== null) {
    await db.update(dbMeta).set({ value }).where(eq(dbMeta.key, key));
  } else {
    await db.insert(dbMeta).values({ key, value });
  }
}

// ── credentials ──

export interface CreateCredentialInput {
  service: string;
  type: string;
  injectMethod: "header" | "query_param";
  injectName: string;
  injectTemplate: string;
  secret: string;
  passphrase: string;
  patterns: string[];
}

export async function createCredential(
  input: CreateCredentialInput,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const agentId = currentAgentId;
  const encrypted = encrypt(input.secret, input.passphrase, `${agentId}:${input.service}`);

  if (isRemoteMode()) {
    const rows = await pgInsert<PgCredentialRow>("credentials", {
      agent_id: agentId,
      service: input.service,
      type: input.type,
      inject_method: input.injectMethod,
      inject_name: input.injectName,
      inject_template: input.injectTemplate,
      encrypted_value: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      salt: encrypted.salt,
      created_at: now,
      updated_at: now,
    });

    const credentialId = rows[0]!.id;

    for (let i = 0; i < input.patterns.length; i++) {
      await pgInsert("url_patterns", {
        credential_id: credentialId,
        pattern: input.patterns[i]!,
        priority: i,
      });
    }

    return credentialId;
  }

  const db = await getDb();

  await db.insert(credentials).values({
    agentId,
    service: input.service,
    type: input.type,
    injectMethod: input.injectMethod,
    injectName: input.injectName,
    injectTemplate: input.injectTemplate,
    encryptedValue: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    salt: encrypted.salt,
    createdAt: now,
    updatedAt: now,
  });

  const inserted = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(eq(credentials.agentId, agentId), eq(credentials.service, input.service)),
    )
    .limit(1);

  const credentialId = inserted[0]!.id;

  if (input.patterns.length > 0) {
    for (let i = 0; i < input.patterns.length; i++) {
      await db.insert(urlPatterns).values({
        credentialId,
        pattern: input.patterns[i]!,
        priority: i,
      });
    }
  }

  return credentialId;
}

export async function listCredentials(): Promise<
  Array<{
    id: number;
    agentId: string;
    service: string;
    type: string;
    injectMethod: string;
    injectName: string;
    injectTemplate: string;
    patterns: string[];
    createdAt: number;
    updatedAt: number;
  }>
> {
  const agentId = currentAgentId;

  if (isRemoteMode()) {
    const creds = await pgSelect<PgCredentialRow>("credentials", {
      agent_id: `eq.${agentId}`,
    });
    const credIds = creds.map((c) => c.id);
    let patterns: PgUrlPatternRow[] = [];
    if (credIds.length > 0) {
      patterns = await pgSelect<PgUrlPatternRow>("url_patterns", {
        credential_id: `in.(${credIds.join(",")})`,
      });
    }

    return creds.map((cred) => ({
      id: cred.id,
      agentId: cred.agent_id,
      service: cred.service,
      type: cred.type,
      injectMethod: cred.inject_method,
      injectName: cred.inject_name,
      injectTemplate: cred.inject_template,
      patterns: patterns
        .filter((p) => p.credential_id === cred.id)
        .sort((a, b) => a.priority - b.priority)
        .map((p) => p.pattern),
      createdAt: cred.created_at,
      updatedAt: cred.updated_at,
    }));
  }

  const db = await getDb();
  const creds = await db
    .select()
    .from(credentials)
    .where(eq(credentials.agentId, agentId));
  const allPatterns = await db.select().from(urlPatterns);

  return creds.map((cred) => ({
    id: cred.id,
    agentId: cred.agentId,
    service: cred.service,
    type: cred.type,
    injectMethod: cred.injectMethod,
    injectName: cred.injectName,
    injectTemplate: cred.injectTemplate,
    patterns: allPatterns
      .filter((p) => p.credentialId === cred.id)
      .sort((a, b) => a.priority - b.priority)
      .map((p) => p.pattern),
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  }));
}

export async function getCredentialByService(service: string) {
  const agentId = currentAgentId;

  if (isRemoteMode()) {
    const rows = await pgSelect<PgCredentialRow>(
      "credentials",
      { agent_id: `eq.${agentId}`, service: `eq.${service}` },
      { limit: 1 },
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id,
      agentId: r.agent_id,
      service: r.service,
      type: r.type,
      injectMethod: r.inject_method,
      injectName: r.inject_name,
      injectTemplate: r.inject_template,
      encryptedValue: r.encrypted_value,
      iv: r.iv,
      authTag: r.auth_tag,
      salt: r.salt,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(eq(credentials.agentId, agentId), eq(credentials.service, service)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getCredentialWithPatterns(service: string) {
  const cred = await getCredentialByService(service);
  if (!cred) return null;

  if (isRemoteMode()) {
    const patterns = await pgSelect<PgUrlPatternRow>("url_patterns", {
      credential_id: `eq.${cred.id}`,
    });
    return {
      ...cred,
      patterns: patterns
        .sort((a, b) => a.priority - b.priority)
        .map((p) => p.pattern),
    };
  }

  const db = await getDb();
  const patterns = await db
    .select()
    .from(urlPatterns)
    .where(eq(urlPatterns.credentialId, cred.id));

  return {
    ...cred,
    patterns: patterns
      .sort((a, b) => a.priority - b.priority)
      .map((p) => p.pattern),
  };
}

export async function decryptCredentialValue(
  service: string,
  passphrase: string,
): Promise<string | null> {
  const cred = await getCredentialByService(service);
  if (!cred) return null;

  const payload: EncryptedPayload = {
    ciphertext: cred.encryptedValue,
    iv: cred.iv,
    authTag: cred.authTag,
    salt: cred.salt,
  };

  return await decrypt(payload, passphrase, `${cred.agentId}:${service}`);
}

export async function updateCredentialSecret(
  service: string,
  newSecret: string,
  passphrase: string,
): Promise<boolean> {
  const cred = await getCredentialByService(service);
  if (!cred) return false;

  const agentId = currentAgentId;
  const encrypted = encrypt(newSecret, passphrase, `${agentId}:${service}`);
  const now = Math.floor(Date.now() / 1000);

  if (isRemoteMode()) {
    await pgUpdate("credentials", {
      agent_id: `eq.${agentId}`,
      service: `eq.${service}`,
    }, {
      encrypted_value: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      salt: encrypted.salt,
      updated_at: now,
    });
    return true;
  }

  const db = await getDb();
  await db
    .update(credentials)
    .set({
      encryptedValue: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      salt: encrypted.salt,
      updatedAt: now,
    })
    .where(
      and(eq(credentials.agentId, agentId), eq(credentials.service, service)),
    );

  return true;
}

export async function deleteCredential(service: string): Promise<boolean> {
  const cred = await getCredentialByService(service);
  if (!cred) return false;

  if (isRemoteMode()) {
    // PostgREST cascades handle child tables if configured, but be explicit
    await pgDelete("url_patterns", { credential_id: `eq.${cred.id}` });
    await pgDelete("oauth_metadata", { credential_id: `eq.${cred.id}` });
    await pgDelete("jwt_metadata", { credential_id: `eq.${cred.id}` });
    await pgDelete("aws_metadata", { credential_id: `eq.${cred.id}` });
    await pgDelete("credentials", { id: `eq.${cred.id}` });
    return true;
  }

  const db = await getDb();
  await db.delete(urlPatterns).where(eq(urlPatterns.credentialId, cred.id));
  await db.delete(oauthMetadata).where(eq(oauthMetadata.credentialId, cred.id));
  await db.delete(jwtMetadata).where(eq(jwtMetadata.credentialId, cred.id));
  await db.delete(awsMetadata).where(eq(awsMetadata.credentialId, cred.id));
  await db.delete(credentials).where(eq(credentials.id, cred.id));

  return true;
}

export async function getAllUrlPatterns(): Promise<
  Array<{ credentialId: number; service: string; pattern: string; priority: number }>
> {
  const agentId = currentAgentId;

  if (isRemoteMode()) {
    const creds = await pgSelect<PgCredentialRow>("credentials", {
      agent_id: `eq.${agentId}`,
    });
    const credIds = creds.map((c) => c.id);
    if (credIds.length === 0) return [];

    const patterns = await pgSelect<PgUrlPatternRow>("url_patterns", {
      credential_id: `in.(${credIds.join(",")})`,
    });

    return patterns.map((p) => {
      const cred = creds.find((c) => c.id === p.credential_id);
      return {
        credentialId: p.credential_id,
        service: cred?.service ?? "unknown",
        pattern: p.pattern,
        priority: p.priority,
      };
    });
  }

  const db = await getDb();
  const creds = await db
    .select({ id: credentials.id, service: credentials.service })
    .from(credentials)
    .where(eq(credentials.agentId, agentId));
  const patterns = await db.select().from(urlPatterns);

  return patterns
    .filter((p) => creds.some((c) => c.id === p.credentialId))
    .map((p) => {
      const cred = creds.find((c) => c.id === p.credentialId);
      return {
        credentialId: p.credentialId,
        service: cred?.service ?? "unknown",
        pattern: p.pattern,
        priority: p.priority,
      };
    });
}

// ── OAuth metadata ──

export interface CreateOAuthMetadataInput {
  credentialId: number;
  tokenUrl: string;
  authorizeUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  usePkce: boolean;
  passphrase: string;
  service: string;
}

export async function createOAuthMetadata(
  input: CreateOAuthMetadataInput,
): Promise<void> {
  const aad = `${currentAgentId}:${input.service}:oauth`;
  const encClientId = encrypt(input.clientId, input.passphrase, aad);

  let encClientSecret: EncryptedPayload | null = null;
  if (input.clientSecret) {
    encClientSecret = encrypt(input.clientSecret, input.passphrase, aad);
  }

  const data = {
    credential_id: input.credentialId,
    token_url: input.tokenUrl,
    authorize_url: input.authorizeUrl ?? null,
    encrypted_client_id: encClientId.ciphertext,
    client_id_iv: encClientId.iv,
    client_id_auth_tag: encClientId.authTag,
    client_id_salt: encClientId.salt,
    encrypted_client_secret: encClientSecret?.ciphertext ?? null,
    client_secret_iv: encClientSecret?.iv ?? null,
    client_secret_auth_tag: encClientSecret?.authTag ?? null,
    client_secret_salt: encClientSecret?.salt ?? null,
    scopes: input.scopes ?? null,
    use_pkce: input.usePkce ? 1 : 0,
  };

  if (isRemoteMode()) {
    await pgInsert("oauth_metadata", data);
    return;
  }

  const db = await getDb();
  await db.insert(oauthMetadata).values({
    credentialId: input.credentialId,
    tokenUrl: input.tokenUrl,
    authorizeUrl: input.authorizeUrl ?? null,
    encryptedClientId: encClientId.ciphertext,
    clientIdIv: encClientId.iv,
    clientIdAuthTag: encClientId.authTag,
    clientIdSalt: encClientId.salt,
    encryptedClientSecret: encClientSecret?.ciphertext ?? null,
    clientSecretIv: encClientSecret?.iv ?? null,
    clientSecretAuthTag: encClientSecret?.authTag ?? null,
    clientSecretSalt: encClientSecret?.salt ?? null,
    scopes: input.scopes ?? null,
    usePkce: input.usePkce ? 1 : 0,
  });
}

export async function getOAuthMetadata(credentialId: number) {
  if (isRemoteMode()) {
    const rows = await pgSelect<Record<string, unknown>>(
      "oauth_metadata",
      { credential_id: `eq.${credentialId}` },
      { limit: 1 },
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id as number,
      credentialId: r.credential_id as number,
      tokenUrl: r.token_url as string,
      authorizeUrl: r.authorize_url as string | null,
      encryptedClientId: r.encrypted_client_id as string,
      clientIdIv: r.client_id_iv as string,
      clientIdAuthTag: r.client_id_auth_tag as string,
      clientIdSalt: r.client_id_salt as string,
      encryptedClientSecret: r.encrypted_client_secret as string | null,
      clientSecretIv: r.client_secret_iv as string | null,
      clientSecretAuthTag: r.client_secret_auth_tag as string | null,
      clientSecretSalt: r.client_secret_salt as string | null,
      scopes: r.scopes as string | null,
      usePkce: r.use_pkce as number,
      encryptedAccessToken: r.encrypted_access_token as string | null,
      accessTokenIv: r.access_token_iv as string | null,
      accessTokenAuthTag: r.access_token_auth_tag as string | null,
      accessTokenSalt: r.access_token_salt as string | null,
      encryptedRefreshToken: r.encrypted_refresh_token as string | null,
      refreshTokenIv: r.refresh_token_iv as string | null,
      refreshTokenAuthTag: r.refresh_token_auth_tag as string | null,
      refreshTokenSalt: r.refresh_token_salt as string | null,
      expiresAt: r.expires_at as number | null,
    };
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(oauthMetadata)
    .where(eq(oauthMetadata.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateOAuthTokens(
  credentialId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
  passphrase: string,
  service: string,
): Promise<void> {
  const aad = `${currentAgentId}:${service}:oauth`;
  const encAccess = encrypt(accessToken, passphrase, aad);

  let encRefresh: EncryptedPayload | null = null;
  if (refreshToken) {
    encRefresh = encrypt(refreshToken, passphrase, aad);
  }

  const updateData = {
    encrypted_access_token: encAccess.ciphertext,
    access_token_iv: encAccess.iv,
    access_token_auth_tag: encAccess.authTag,
    access_token_salt: encAccess.salt,
    encrypted_refresh_token: encRefresh?.ciphertext ?? null,
    refresh_token_iv: encRefresh?.iv ?? null,
    refresh_token_auth_tag: encRefresh?.authTag ?? null,
    refresh_token_salt: encRefresh?.salt ?? null,
    expires_at: expiresAt,
  };

  if (isRemoteMode()) {
    await pgUpdate("oauth_metadata", {
      credential_id: `eq.${credentialId}`,
    }, updateData);
    return;
  }

  const db = await getDb();
  await db
    .update(oauthMetadata)
    .set({
      encryptedAccessToken: encAccess.ciphertext,
      accessTokenIv: encAccess.iv,
      accessTokenAuthTag: encAccess.authTag,
      accessTokenSalt: encAccess.salt,
      encryptedRefreshToken: encRefresh?.ciphertext ?? null,
      refreshTokenIv: encRefresh?.iv ?? null,
      refreshTokenAuthTag: encRefresh?.authTag ?? null,
      refreshTokenSalt: encRefresh?.salt ?? null,
      expiresAt,
    })
    .where(eq(oauthMetadata.credentialId, credentialId));
}

// ── JWT metadata ──

export interface CreateJwtMetadataInput {
  credentialId: number;
  algorithm: string;
  issuer?: string;
  audience?: string;
  expirySeconds: number;
  customClaims?: string;
}

export async function createJwtMetadata(
  input: CreateJwtMetadataInput,
): Promise<void> {
  if (isRemoteMode()) {
    await pgInsert("jwt_metadata", {
      credential_id: input.credentialId,
      algorithm: input.algorithm,
      issuer: input.issuer ?? null,
      audience: input.audience ?? null,
      expiry_seconds: input.expirySeconds,
      custom_claims: input.customClaims ?? null,
    });
    return;
  }

  const db = await getDb();
  await db.insert(jwtMetadata).values({
    credentialId: input.credentialId,
    algorithm: input.algorithm,
    issuer: input.issuer ?? null,
    audience: input.audience ?? null,
    expirySeconds: input.expirySeconds,
    customClaims: input.customClaims ?? null,
  });
}

export async function getJwtMetadata(credentialId: number) {
  if (isRemoteMode()) {
    const rows = await pgSelect<Record<string, unknown>>(
      "jwt_metadata",
      { credential_id: `eq.${credentialId}` },
      { limit: 1 },
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id as number,
      credentialId: r.credential_id as number,
      algorithm: r.algorithm as string,
      issuer: r.issuer as string | null,
      audience: r.audience as string | null,
      expirySeconds: r.expiry_seconds as number,
      customClaims: r.custom_claims as string | null,
    };
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(jwtMetadata)
    .where(eq(jwtMetadata.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

// ── AWS metadata ──

export interface CreateAwsMetadataInput {
  credentialId: number;
  region: string;
  awsService: string;
  sessionToken?: string;
  passphrase: string;
  service: string;
}

export async function createAwsMetadata(
  input: CreateAwsMetadataInput,
): Promise<void> {
  let encSessionToken: EncryptedPayload | null = null;
  if (input.sessionToken) {
    const aad = `${currentAgentId}:${input.service}:aws`;
    encSessionToken = encrypt(input.sessionToken, input.passphrase, aad);
  }

  if (isRemoteMode()) {
    await pgInsert("aws_metadata", {
      credential_id: input.credentialId,
      region: input.region,
      aws_service: input.awsService,
      encrypted_session_token: encSessionToken?.ciphertext ?? null,
      session_token_iv: encSessionToken?.iv ?? null,
      session_token_auth_tag: encSessionToken?.authTag ?? null,
      session_token_salt: encSessionToken?.salt ?? null,
    });
    return;
  }

  const db = await getDb();
  await db.insert(awsMetadata).values({
    credentialId: input.credentialId,
    region: input.region,
    awsService: input.awsService,
    encryptedSessionToken: encSessionToken?.ciphertext ?? null,
    sessionTokenIv: encSessionToken?.iv ?? null,
    sessionTokenAuthTag: encSessionToken?.authTag ?? null,
    sessionTokenSalt: encSessionToken?.salt ?? null,
  });
}

export async function getAwsMetadata(credentialId: number) {
  if (isRemoteMode()) {
    const rows = await pgSelect<Record<string, unknown>>(
      "aws_metadata",
      { credential_id: `eq.${credentialId}` },
      { limit: 1 },
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: r.id as number,
      credentialId: r.credential_id as number,
      region: r.region as string,
      awsService: r.aws_service as string,
      encryptedSessionToken: r.encrypted_session_token as string | null,
      sessionTokenIv: r.session_token_iv as string | null,
      sessionTokenAuthTag: r.session_token_auth_tag as string | null,
      sessionTokenSalt: r.session_token_salt as string | null,
    };
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(awsMetadata)
    .where(eq(awsMetadata.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
}
