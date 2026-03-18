<p align="center">
  <h1 align="center">Clawth</h1>
  <p align="center">Let AI agents make authenticated API calls — without ever seeing your secrets.</p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#commands">Commands</a> &bull;
  <a href="#credential-types">Credential Types</a> &bull;
  <a href="#remote-database">Remote Database</a> &bull;
  <a href="#environment-variables">Environment Variables</a>
</p>

---

## The Problem

You want Claude Code (or any AI agent) to call APIs on your behalf. But those APIs need authentication — and you **don't want your tokens in the chat, in process arguments, or anywhere the agent can read them**.

## The Solution

Clawth is a credential proxy. Your agent runs `clawth curl` instead of `curl`. Clawth looks up the right credential, injects the auth header, and executes the request. The agent never sees the secret.

```
Agent runs:     clawth curl https://api.github.com/user
What happens:   curl -H "Authorization: Bearer ghp_****" https://api.github.com/user
Agent sees:     the API response (never the token)
```

Secrets are encrypted at rest with AES-256-GCM. Each agent gets its own passphrase and isolated credential store.

## Quick Start

```bash
# Install
git clone https://github.com/your-org/clawth && cd clawth
bun install

# Set up (creates encrypted DB, starts session daemon, installs Claude Code skill)
bun run bin/clawth.ts setup --passphrase "your-passphrase"

# Add a credential
bun run bin/clawth.ts set github --type bearer --pattern "*.github.com" --secret "ghp_your_token"

# Make an authenticated request
bun run bin/clawth.ts curl https://api.github.com/user
```

That's it. Every `clawth curl` to `*.github.com` now uses your token automatically.

## How It Works

```
┌──────────────┐     clawth curl url     ┌──────────┐     curl + auth header     ┌─────────┐
│  Claude Code │ ──────────────────────> │  Clawth  │ ────────────────────────> │   API   │
│  (no secret) │ <────────────────────── │  (proxy) │ <──────────────────────── │ Server  │
└──────────────┘     API response        └──────────┘     API response          └─────────┘
                                              │
                                              ▼
                                     ┌─────────────────┐
                                     │  Encrypted DB    │
                                     │  (local / remote)│
                                     └─────────────────┘
```

1. **URL matching** — Clawth matches the request URL against stored glob patterns (`*.github.com`, `api.openai.com`, etc.)
2. **Decryption** — The matching credential is decrypted using your passphrase (cached by the session daemon)
3. **Injection** — Auth headers are piped to curl via `--config stdin` — secrets never appear in `ps aux`
4. **Response** — The API response is passed through to the agent

If no credential matches, Clawth tells the agent exactly what to do:

```
CLAWTH_NO_CREDENTIAL
url=https://api.stripe.com/v1/charges
suggested_service=stripe
suggested_pattern=*.stripe.com
suggested_type=bearer

To add this credential, run:
  clawth set stripe --type bearer --pattern "*.stripe.com" --secret <TOKEN>
```

## Commands

| Command | Description |
|---|---|
| `clawth setup` | Initialize everything (DB, skill, session daemon) |
| `clawth curl <url> [flags]` | Make an authenticated request |
| `clawth set <service> --type <type> --pattern "<glob>" [--secret <val>]` | Store or update a credential |
| `clawth delete <service>` | Remove a credential |
| `clawth list` | Show all stored credentials (never secrets) |
| `clawth status` | Show agent, DB, daemon, and credential status |
| `clawth which <url>` | Show which credential matches a URL |
| `clawth check [service]` | Verify credentials can be decrypted |
| `clawth audit [--usage]` | View API call history and per-service stats |
| `clawth login <service>` | Browser-based OAuth2 PKCE login |
| `clawth session start\|stop` | Manage the passphrase cache daemon |
| `clawth export <file>` | Export credentials as an encrypted bundle |
| `clawth import <file>` | Import credentials from an encrypted bundle |
| `clawth completion <bash\|zsh\|fish>` | Generate shell completions |

## Credential Types

```bash
# Bearer token (GitHub, Slack, OpenAI, etc.)
clawth set github --type bearer --pattern "*.github.com" --secret "ghp_xxxx"

# API key in a custom header
clawth set openai --type api_key --header Authorization \
  --template "Bearer {token}" --pattern "api.openai.com" --secret "sk-xxxx"

# API key as a query parameter
clawth set maps --type api_key --query-param key \
  --pattern "maps.googleapis.com" --secret "AIza..."

# Basic auth
clawth set registry --type basic --pattern "registry.example.com" --secret "user:password"

# OAuth2 (with automatic token refresh)
clawth set google --type oauth2 --pattern "*.googleapis.com" \
  --token-url https://oauth2.googleapis.com/token --client-id <id>

# OAuth2 PKCE (public clients, browser login)
clawth set myapp --type oauth2_pkce --pattern "api.myapp.com" \
  --authorize-url https://myapp.com/authorize \
  --token-url https://myapp.com/token --client-id <id>
clawth login myapp  # opens browser

# JWT signing
clawth set zoom --type jwt --pattern "api.zoom.us" \
  --algorithm HS256 --issuer <key> --expiry-seconds 3600

# AWS Signature V4
clawth set aws --type aws_sigv4 --pattern "*.amazonaws.com" \
  --region us-east-1 --aws-service s3 --secret "AKIA...:wJal..."

# mTLS (client certificate)
clawth set internal --type p12 --pattern "api.internal.com" --secret "<base64-p12>"
```

## Claude Code Integration

After `clawth setup`, the `/clawth` skill is automatically installed. Claude Code can:

- **Make API calls**: `clawth curl https://api.github.com/repos/owner/repo`
- **Store credentials**: `clawth set stripe --type bearer --pattern "*.stripe.com" --secret "<token>"`
- **Handle errors**: When a request fails, Clawth outputs structured `CLAWTH_*` hints that Claude follows automatically

Claude Code **cannot** read stored secret values — it can only store new ones and use them via `clawth curl`.

## Multi-Agent Support

Each agent gets its own isolated credentials and passphrase:

```bash
# Set up agent "bot-1"
clawth setup --agent bot-1 --passphrase "secret-for-bot-1"
clawth set github --type bearer --pattern "*.github.com" --secret "ghp_bot1_token"

# Set up agent "bot-2" with different credentials
clawth setup --agent bot-2 --passphrase "secret-for-bot-2"
clawth set github --type bearer --pattern "*.github.com" --secret "ghp_bot2_token"
```

Agents cannot access each other's credentials — different passphrase, different encryption keys.

## Remote Database

For persistent environments (servers, CI/CD), store credentials in a remote PostgreSQL database via [PostgREST](https://postgrest.org):

```bash
clawth setup \
  --agent prod-agent \
  --passphrase "server-passphrase" \
  --remote https://postgrest.example.com \
  --remote-jwt ./jwt.json
```

All subsequent commands automatically use the remote database. Credentials are still encrypted client-side — the server only stores ciphertext.

## Environment Variables

All setup options can be set via environment variables:

| Variable | Description |
|---|---|
| `CLAWTH_AGENT_ID` | Agent ID (default: `default`) |
| `CLAWTH_AGENT_PASSPHRASE` | Passphrase for decryption |
| `CLAWTH_REMOTE` | PostgREST server URL |
| `CLAWTH_REMOTE_JWT` | JWT for PostgREST auth |
| `CLAWTH_SESSION_KEY` | Base64-encoded passphrase (alternative to daemon) |

## Session Daemon

The session daemon caches your passphrase in memory so you don't have to enter it for every command:

```bash
clawth session start   # prompts for passphrase, caches for 4 hours
clawth session stop    # clear cached passphrase immediately
```

The daemon communicates over a Unix socket with `0o700` directory permissions. It auto-exits after 4 hours of inactivity.

## Security Model

- **Encryption**: AES-256-GCM with per-credential random IV and salt
- **Key derivation**: PBKDF2-SHA512 with 210,000 iterations
- **AAD binding**: Each credential is bound to its agent ID and service name — prevents row-swapping attacks
- **Process isolation**: Secrets are piped to curl via `--config stdin`, never as CLI arguments
- **No secret readback**: There is no command to display a stored secret — by design

## License

MIT
