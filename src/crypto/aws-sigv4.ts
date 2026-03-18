import { createHmac, createHash } from "node:crypto";

export interface AwsSigV4Input {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

export interface AwsSigV4Result {
  headers: Record<string, string>;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

export function signAwsSigV4(input: AwsSigV4Input): AwsSigV4Result {
  const { amzDate, dateStamp } = getAmzDate();
  const parsedUrl = new URL(input.url);

  // Step 1: Create canonical request
  const canonicalUri = parsedUrl.pathname || "/";

  // Sort query parameters
  const searchParams = new URLSearchParams(parsedUrl.search);
  const sortedParams = [...searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  // Prepare headers
  const host = parsedUrl.host;
  const headersToSign: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    ...input.headers,
  };

  if (input.sessionToken) {
    headersToSign["x-amz-security-token"] = input.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(headersToSign)
    .map((k) => k.toLowerCase())
    .sort();

  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headersToSign[k] ?? headersToSign[k.charAt(0).toUpperCase() + k.slice(1)] ?? ""}`)
    .join("\n") + "\n";

  const signedHeaders = sortedHeaderKeys.join(";");
  const payloadHash = sha256(input.body || "");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    sortedParams,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // Step 2: Create string to sign
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  // Step 3: Calculate signing key
  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, "aws4_request");

  // Step 4: Calculate signature
  const signature = hmacSha256Hex(kSigning, stringToSign);

  // Step 5: Build authorization header
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resultHeaders: Record<string, string> = {
    Authorization: authorization,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
  };

  if (input.sessionToken) {
    resultHeaders["X-Amz-Security-Token"] = input.sessionToken;
  }

  return { headers: resultHeaders };
}
