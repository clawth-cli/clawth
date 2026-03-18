import { createHmac, createSign } from "node:crypto";

export interface JwtHeader {
  alg: string;
  typ: "JWT";
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export function signJwt(
  payload: JwtPayload,
  signingKey: string,
  algorithm: "RS256" | "HS256" = "RS256",
): string {
  const header: JwtHeader = { alg: algorithm, typ: "JWT" };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    iat: now,
    ...payload,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  let signature: string;

  if (algorithm === "RS256") {
    const sign = createSign("RSA-SHA256");
    sign.update(signingInput);
    signature = sign.sign(signingKey, "base64url");
  } else {
    // HS256
    const hmac = createHmac("sha256", signingKey);
    hmac.update(signingInput);
    signature = hmac.digest("base64url");
  }

  return `${signingInput}.${signature}`;
}
