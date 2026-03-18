import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

export const credentials = sqliteTable(
  "credentials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull().default("default"),
    service: text("service").notNull(),
    type: text("type").notNull(), // api_key, bearer, basic, oauth2, oauth2_pkce, jwt, aws_sigv4, p12, service_account
    injectMethod: text("inject_method").notNull().default("header"), // header | query_param
    injectName: text("inject_name").notNull(), // e.g., "Authorization" or "api_key"
    injectTemplate: text("inject_template").notNull(), // e.g., "Bearer {token}"
    encryptedValue: text("encrypted_value").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    salt: text("salt").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.service)],
);

export const urlPatterns = sqliteTable("url_patterns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
  pattern: text("pattern").notNull(),
  priority: integer("priority").notNull().default(0),
});

export const oauthMetadata = sqliteTable("oauth_metadata", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
  tokenUrl: text("token_url").notNull(),
  authorizeUrl: text("authorize_url"),
  encryptedClientId: text("encrypted_client_id").notNull(),
  clientIdIv: text("client_id_iv").notNull(),
  clientIdAuthTag: text("client_id_auth_tag").notNull(),
  clientIdSalt: text("client_id_salt").notNull(),
  encryptedClientSecret: text("encrypted_client_secret"),
  clientSecretIv: text("client_secret_iv"),
  clientSecretAuthTag: text("client_secret_auth_tag"),
  clientSecretSalt: text("client_secret_salt"),
  scopes: text("scopes"),
  usePkce: integer("use_pkce").notNull().default(0),
  encryptedAccessToken: text("encrypted_access_token"),
  accessTokenIv: text("access_token_iv"),
  accessTokenAuthTag: text("access_token_auth_tag"),
  accessTokenSalt: text("access_token_salt"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  refreshTokenIv: text("refresh_token_iv"),
  refreshTokenAuthTag: text("refresh_token_auth_tag"),
  refreshTokenSalt: text("refresh_token_salt"),
  expiresAt: integer("expires_at"),
});

export const jwtMetadata = sqliteTable("jwt_metadata", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
  algorithm: text("algorithm").notNull().default("RS256"),
  issuer: text("issuer"),
  audience: text("audience"),
  expirySeconds: integer("expiry_seconds").notNull().default(3600),
  customClaims: text("custom_claims"), // JSON string
});

export const awsMetadata = sqliteTable("aws_metadata", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  awsService: text("aws_service").notNull(),
  encryptedSessionToken: text("encrypted_session_token"),
  sessionTokenIv: text("session_token_iv"),
  sessionTokenAuthTag: text("session_token_auth_tag"),
  sessionTokenSalt: text("session_token_salt"),
});

export const dbMeta = sqliteTable("db_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: text("agent_id").notNull(),
  service: text("service").notNull(),
  url: text("url").notNull(),
  method: text("method").notNull(),
  statusCode: integer("status_code"),
  timestamp: integer("timestamp").notNull(),
});
