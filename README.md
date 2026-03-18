<p align="center">
  <img src="assets/logo.jpg" alt="Clawth" width="120" />
</p>
<h1 align="center">Clawth</h1>
<p align="center">API keys for AI agents — encrypted, injected, never exposed.</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#claude-code-integration">Claude Code</a> &bull;
  <a href="#commands">Commands</a> &bull;
  <a href="#remote-database">Remote DB</a> &bull;
  <a href="#security-model">Security</a>
</p>

---

## Without Clawth

> ❌ Token hardcoded in the command — visible in chat history, shell history, and `ps aux`
```bash
curl -H "Authorization: Bearer ghp_R3aLt0k3n..." https://api.github.com/user
```

> ❌ Agent asks for the token — now it's in the conversation context, logged, and cached
```
Claude: "Please paste your GitHub token so I can make this API call"
You:    "ghp_R3aLt0k3n..."
```

> ❌ Token in plain text env vars — anyone with shell access can read it
```bash
export GITHUB_TOKEN=ghp_R3aLt0k3n...
```

This gets worse when you're not working alone:

- **Shared Claude Code sessions** — your teammates see every token pasted in chat. One person's production API key is now in everyone's conversation history.
- **Remote servers / CI** — env vars and shell history persist on disk. Anyone with SSH access can harvest every credential.
- **Delegating access** — a colleague wants to let you use their API key without showing it to you. There's no way to do that with plain text tokens.

## With Clawth

> ✅ Agent runs `clawth curl` — the token is encrypted, injected at runtime, and never exposed
```bash
clawth curl https://api.github.com/user
# → Clawth decrypts the credential, pipes auth via stdin to curl
# → The agent only sees the API response, never the token
```

> ✅ Credentials are encrypted at rest with AES-256-GCM — even if someone reads the database file, they get ciphertext

> ✅ Each agent gets its own passphrase and isolated credential store — no cross-agent leaks

---

## Quick Start

**1. Install and set up:**
```bash
npx clawth
```

The wizard sets up everything — encrypted database, passphrase, session daemon, and Claude Code skill.

**2. Add your API keys:**
```bash
clawth creds
```

The interactive credential manager lets you search providers, paste your key, and validates it works:

```
  Provider: git
  ❯ GitHub       *.github.com
    GitLab       *.gitlab.com

  Get your key at: https://github.com/settings/tokens
  API key: ****
  ✓ Key is valid
```

Built-in presets for GitHub, OpenAI, Anthropic, Stripe, Slack, ElevenLabs, Vercel, Cloudflare, and [15+ more](src/cli/providers.ts) — or add any custom API.

**3. Use it:**
```bash
clawth curl https://api.github.com/user
clawth curl https://api.openai.com/v1/models
```

That's it. Credentials are resolved by URL pattern, decrypted, and injected automatically.

---

## How It Works

```
                clawth curl url              curl + auth header
  +-----------+  ─────────────>  +--------+  ─────────────────>  +--------+
  |  Claude   |                  |        |                      |  API   |
  |   Code    |                  | Clawth |                      | Server |
  | (no secret)                  | (proxy)|                      |        |
  +-----------+  <─────────────  +--------+  <─────────────────  +--------+
                  API response       |        API response
                                     |
                                     v
                              +--------------+
                              | Encrypted DB |
                              |  local or    |
                              |  remote      |
                              +--------------+
```

1. **URL matching** — Clawth matches the request URL against stored glob patterns (`*.github.com`, `api.openai.com`, etc.)
2. **Decryption** — The matching credential is decrypted using your passphrase (cached by the session daemon)
3. **Injection** — Auth headers are piped to curl via `--config stdin` — secrets never appear in `ps aux`
4. **Response** — The API response is passed through to the agent

If no credential matches, Clawth tells the agent exactly what to do — with the exact command to run.

## Claude Code Integration

After `npx clawth`, the `/clawth` skill is automatically installed in Claude Code. Claude can:

- **Make API calls**: `clawth curl https://api.github.com/repos/owner/repo`
- **Store credentials**: `clawth set stripe --type bearer --pattern "*.stripe.com" --secret "<token>"`
- **Self-recover from errors**: When a request fails, Clawth outputs structured `CLAWTH_*` hints that Claude follows automatically to fix the issue and retry

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

To deploy your own compatible backend, see **[Remote Database Setup Guide](REMOTE_DB_SETUP.md)**.

## Headless / Remote Server Setup

For CI, Docker, or remote servers where there's no TTY — pass everything as flags:

```bash
# One-line setup (auto-generates passphrase if omitted)
npx clawth setup --passphrase "secret" --agent "prod-bot"

# Add credentials non-interactively
clawth set github --type bearer --pattern "*.github.com" --secret "$GITHUB_TOKEN"
clawth set openai --type api_key --header Authorization \
  --template "Bearer {token}" --pattern "api.openai.com" --secret "$OPENAI_KEY"

# Ready to use
clawth curl https://api.github.com/user
```

Or use environment variables — same result, nothing to type:

```bash
export CLAWTH_AGENT_ID="prod-bot"
export CLAWTH_AGENT_PASSPHRASE="secret"
export CLAWTH_REMOTE="https://postgrest.example.com"
export CLAWTH_REMOTE_JWT="eyJ..."

npx clawth setup
clawth set github --type bearer --pattern "*.github.com" --secret "$GITHUB_TOKEN"
```

## Commands

| Command | Description |
|---|---|
| `clawth setup` | Initialize everything (DB, skill, daemon) |
| `clawth creds` | Interactive credential manager with provider presets |
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

## Environment Variables

| Variable | Description |
|---|---|
| `CLAWTH_AGENT_ID` | Agent ID (default: `default`) |
| `CLAWTH_AGENT_PASSPHRASE` | Passphrase for decryption |
| `CLAWTH_REMOTE` | PostgREST server URL |
| `CLAWTH_REMOTE_JWT` | JWT for PostgREST auth |
| `CLAWTH_SESSION_KEY` | Base64-encoded passphrase (alternative to daemon) |

## Security Model

- **Encryption**: AES-256-GCM with per-credential random IV and salt
- **Key derivation**: PBKDF2-SHA512 with 210,000 iterations
- **AAD binding**: Each credential is bound to its agent ID and service name — prevents row-swapping attacks
- **Process isolation**: Secrets are piped to curl via `--config stdin`, never as CLI arguments
- **No secret readback**: There is no command to display a stored secret — by design

## License

MIT
