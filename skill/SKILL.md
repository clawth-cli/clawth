---
name: clawth
description: Make authenticated API calls without seeing credentials. Use when you need to call any external API (GitHub, Slack, AWS, Google, etc.), make HTTP requests that require authentication, or manage stored API credentials. Triggers on phrases like "call the API", "fetch from", "make a request to", "list credentials", "add credential".
allowed-tools: Bash(clawth *), Bash(echo *)
---

# Clawth — Authenticated API Proxy

You have access to `clawth`, a CLI tool that lets you make authenticated API calls **without ever seeing the credentials**. Secrets are encrypted and scoped per agent — you can manage credentials but **never read actual secret values**.

## How it works

When you run `clawth curl <url>`, Clawth:
1. Loads the agent, remote DB, and passphrase from the persisted config (set during `clawth setup`)
2. Matches the URL against stored credential patterns for the configured agent
3. If a match is found: decrypts the credential, injects auth headers, executes curl
4. **If something goes wrong**: outputs a structured `CLAWTH_*` hint with the exact fix

All configuration (agent ID, remote database, passphrase) is set once during `clawth setup` and persisted. You do not need to pass these on every command.

## Error hint reference

When `clawth curl` encounters an error, it outputs a structured block on stderr. **Always read the hint code and follow the suggested actions.**

| Hint code | Meaning | What to do |
|---|---|---|
| `CLAWTH_NO_CREDENTIAL` | No credential matches the URL | `clawth set <service> --type bearer --pattern "<pattern>" --secret <TOKEN>` |
| `CLAWTH_AUTH_EXPIRED` | Got HTTP 401/403 — token expired or invalid | `clawth set <service> --type <type> --secret <NEW_TOKEN>` |
| `CLAWTH_DECRYPT_FAILED` | Can't decrypt — wrong passphrase or corrupted | `clawth session start` or re-set the credential |
| `CLAWTH_OAUTH_LOGIN_REQUIRED` | OAuth2 has no tokens — needs browser login | `clawth login <service>` |
| `CLAWTH_OAUTH_REFRESH_FAILED` | OAuth2 refresh token revoked | `clawth login <service>` to re-authenticate |
| `CLAWTH_SERVICE_ACCOUNT_FAILED` | Service account JWT exchange failed | Re-set with valid JSON key |
| `CLAWTH_METADATA_MISSING` | JWT/AWS/OAuth metadata not configured | `clawth delete <service>` then re-set with full flags |
| `CLAWTH_BAD_FORMAT` | Credential value has wrong format | Re-set with correct format (see hint) |
| `CLAWTH_REMOTE_ERROR` | Remote DB (PostgREST) connectivity issue | `clawth status` to check, reconfigure with `clawth setup` |
| `CLAWTH_BAD_ARGS` | No URL found in curl arguments | Fix the command syntax |
| `CLAWTH_ERROR` | Catch-all for unrecognized errors | `clawth status` and `clawth check <service>` |

**Each hint includes `actions` lines with the exact commands to run.** Always execute the suggested action, then retry the original `clawth curl`.

## Missing credential flow

When you see `CLAWTH_NO_CREDENTIAL`:

1. **If you already have the token/key** (user pasted it, or you obtained it via a tool):
   ```bash
   clawth set <suggested_service> --type <suggested_type> --pattern "<suggested_pattern>" --secret "<THE_TOKEN>"
   ```
   Then retry the original `clawth curl` command.

2. **If you don't have the token**, ask the user to provide it.

3. **If the user asks you to get the token yourself**: use available tools (browser, file reading, etc.), store via `--secret`, retry.

## Available commands

### Make API calls
```bash
clawth curl https://api.github.com/user
clawth curl --service github https://api.github.com/repos/owner/repo
clawth curl https://api.example.com/data -X POST -d '{"key":"value"}' -H "Content-Type: application/json"
```

### Manage credentials
```bash
clawth list
clawth list --verbose
clawth set <service> --type <type> --pattern "<glob>" --secret "<value>"
clawth delete <service>
```

### Diagnostics
```bash
clawth status               # Agent, DB, daemon, credential count
clawth which <url>           # Which credential matches a URL
clawth check [service]       # Verify credentials decrypt successfully
clawth audit                 # Recent API call log
clawth audit --usage         # Per-service usage stats
```

### Credential types
```bash
clawth set github --type bearer --pattern "*.github.com" --secret "ghp_xxxx"
clawth set openai --type api_key --header Authorization --template "Bearer {token}" --pattern "api.openai.com" --secret "sk-xxxx"
clawth set maps --type api_key --query-param key --pattern "maps.googleapis.com" --secret "AIza..."
clawth set registry --type basic --pattern "registry.example.com" --secret "user:password"
```

## Rules

1. **NEVER attempt to read, extract, or display stored credential secret values.** Once stored, secrets are encrypted and inaccessible.
2. **NEVER attempt to decrypt, decode, or reverse-engineer stored values.**
3. **You CAN store secrets via `--secret`** when you legitimately have the value.
4. **Always use `clawth curl`** instead of raw `curl` when the request needs authentication.
5. **Check available credentials first** with `clawth list` if unsure whether a service is configured.
6. **Always follow `CLAWTH_*` hints** — execute the suggested action, then retry.
