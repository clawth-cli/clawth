/**
 * Structured error hints for Claude Code.
 *
 * When clawth runs non-interactively (piped from Claude Code),
 * errors are emitted as machine-readable CLAWTH_* blocks on stderr
 * so Claude can parse them and take corrective action.
 */

interface Hint {
  code: string;
  fields: Record<string, string>;
  message: string;
  actions: string[];
}

function emit(hint: Hint): void {
  console.error(``);
  console.error(hint.code);
  for (const [k, v] of Object.entries(hint.fields)) {
    console.error(`${k}=${v}`);
  }
  console.error(``);
  console.error(hint.message);
  for (const action of hint.actions) {
    console.error(`  ${action}`);
  }
}

const isInteractive = (): boolean => process.stdin.isTTY ?? false;

// ── Hint matchers: map error messages to structured hints ──

interface ErrorContext {
  service?: string;
  url?: string;
  error: Error;
}

export function emitErrorHint(ctx: ErrorContext): boolean {
  if (isInteractive()) return false; // Let interactive mode show raw errors

  const msg = ctx.error.message;
  const service = ctx.service ?? "unknown";

  // Decryption failure
  if (msg.includes("Failed to decrypt") || msg.includes("Unsupported state") || msg.includes("unable to authenticate")) {
    emit({
      code: "CLAWTH_DECRYPT_FAILED",
      fields: { service },
      message: `Failed to decrypt credential '${service}'. The passphrase may be wrong or the credential is corrupted.`,
      actions: [
        `clawth session start    # Re-enter the passphrase`,
        `clawth set ${service} --type bearer --secret <NEW_TOKEN>    # Re-set the credential`,
      ],
    });
    return true;
  }

  // OAuth2 no refresh token
  if (msg.includes("No refresh token") || msg.includes("No valid tokens")) {
    emit({
      code: "CLAWTH_OAUTH_LOGIN_REQUIRED",
      fields: { service },
      message: `OAuth2 credential '${service}' has no valid tokens. Browser login required.`,
      actions: [
        `clawth login ${service}    # Opens browser for OAuth2 PKCE login`,
      ],
    });
    return true;
  }

  // OAuth2 token refresh failed
  if (msg.includes("Token refresh failed")) {
    emit({
      code: "CLAWTH_OAUTH_REFRESH_FAILED",
      fields: { service },
      message: `OAuth2 token refresh failed for '${service}'. The refresh token may be revoked.`,
      actions: [
        `clawth login ${service}    # Re-authenticate via browser`,
        `clawth delete ${service}    # Remove and re-create the credential`,
      ],
    });
    return true;
  }

  // Service account exchange failed
  if (msg.includes("Service account token exchange failed")) {
    emit({
      code: "CLAWTH_SERVICE_ACCOUNT_FAILED",
      fields: { service },
      message: `Service account JWT exchange failed for '${service}'. The service account key may be invalid.`,
      actions: [
        `clawth set ${service} --type service_account --secret '<JSON_KEY>'    # Re-set with valid key`,
      ],
    });
    return true;
  }

  // JWT metadata missing
  if (msg.includes("JWT metadata not found")) {
    emit({
      code: "CLAWTH_METADATA_MISSING",
      fields: { service, metadata_type: "jwt" },
      message: `JWT metadata missing for '${service}'. The credential was set without required JWT configuration.`,
      actions: [
        `clawth delete ${service}`,
        `clawth set ${service} --type jwt --algorithm RS256 --issuer <ISS> --audience <AUD> --secret '<KEY>'`,
      ],
    });
    return true;
  }

  // AWS metadata missing
  if (msg.includes("AWS metadata not found")) {
    emit({
      code: "CLAWTH_METADATA_MISSING",
      fields: { service, metadata_type: "aws" },
      message: `AWS metadata missing for '${service}'. The credential was set without required AWS configuration.`,
      actions: [
        `clawth delete ${service}`,
        `clawth set ${service} --type aws_sigv4 --region <REGION> --aws-service <SERVICE> --secret '<ACCESS_KEY:SECRET_KEY>'`,
      ],
    });
    return true;
  }

  // OAuth metadata missing
  if (msg.includes("OAuth metadata not found")) {
    emit({
      code: "CLAWTH_METADATA_MISSING",
      fields: { service, metadata_type: "oauth" },
      message: `OAuth metadata missing for '${service}'. The credential was set without required OAuth configuration.`,
      actions: [
        `clawth delete ${service}`,
        `clawth set ${service} --type oauth2 --token-url <URL> --client-id <ID> --pattern '<PATTERN>'`,
      ],
    });
    return true;
  }

  // Invalid AWS credential format
  if (msg.includes("Invalid AWS credential format")) {
    emit({
      code: "CLAWTH_BAD_FORMAT",
      fields: { service, expected_format: "access_key_id:secret_access_key" },
      message: `AWS credential '${service}' has invalid format. Expected 'access_key_id:secret_access_key'.`,
      actions: [
        `clawth set ${service} --type aws_sigv4 --region <REGION> --aws-service <SERVICE> --secret 'AKIA...:wJal...'`,
      ],
    });
    return true;
  }

  // PostgREST connectivity errors
  if (msg.includes("PostgREST")) {
    emit({
      code: "CLAWTH_REMOTE_ERROR",
      fields: { service },
      message: `Remote database error: ${msg}`,
      actions: [
        `clawth status    # Check remote configuration`,
        `clawth setup --remote <URL> --remote-jwt <TOKEN>    # Reconfigure remote DB`,
      ],
    });
    return true;
  }

  // No URL in curl args
  if (msg.includes("No URL found")) {
    emit({
      code: "CLAWTH_BAD_ARGS",
      fields: {},
      message: "No URL found in curl arguments.",
      actions: [
        `clawth curl https://api.example.com/endpoint`,
        `clawth curl https://api.example.com/data -X POST -d '{"key":"value"}'`,
      ],
    });
    return true;
  }

  // Credential not found (after service was resolved)
  if (msg.includes("Credential not found")) {
    const svc = msg.match(/Credential not found: (.+)/)?.[1] ?? service;
    emit({
      code: "CLAWTH_NO_CREDENTIAL",
      fields: { service: svc },
      message: `Credential '${svc}' was referenced but doesn't exist.`,
      actions: [
        `clawth set ${svc} --type bearer --pattern '<PATTERN>' --secret <TOKEN>`,
        `clawth list    # Check available credentials`,
      ],
    });
    return true;
  }

  // Unknown credential type
  if (msg.includes("Unknown credential type")) {
    const type = msg.match(/Unknown credential type: (.+)/)?.[1] ?? "unknown";
    emit({
      code: "CLAWTH_BAD_TYPE",
      fields: { service, type },
      message: `Unknown credential type '${type}' for service '${service}'.`,
      actions: [
        `clawth delete ${service}`,
        `clawth set ${service} --type bearer --secret <TOKEN>    # Valid types: api_key, bearer, basic, oauth2, oauth2_pkce, jwt, aws_sigv4, p12, service_account`,
      ],
    });
    return true;
  }

  // Fallback: unrecognized error
  emit({
    code: "CLAWTH_ERROR",
    fields: { service },
    message: msg,
    actions: [
      `clawth status    # Check configuration`,
      `clawth check ${service}    # Verify credential health`,
    ],
  });
  return true;
}
