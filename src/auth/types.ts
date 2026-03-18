export type CredentialType =
  | "api_key"
  | "bearer"
  | "basic"
  | "oauth2"
  | "oauth2_pkce"
  | "jwt"
  | "aws_sigv4"
  | "p12"
  | "service_account";

export interface AuthResult {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  curlExtraArgs?: string[];
}

export interface AuthContext {
  agentId: string;
  service: string;
  passphrase: string;
  credentialId: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  body?: string;
}

export interface AuthStrategy {
  type: CredentialType;
  resolve(ctx: AuthContext): Promise<AuthResult>;
}
