---
name: clawth
description: Make authenticated API calls without seeing credentials. Use when you need to call any external API (GitHub, Slack, AWS, Google, etc.), make HTTP requests that require authentication, or manage stored API credentials. Triggers on phrases like "call the API", "fetch from", "make a request to", "list credentials", "add credential".
allowed-tools: Bash(clawth *), Bash(echo *)
---

# Clawth

Use `clawth curl` instead of `curl` when a request needs authentication. Clawth injects the right credentials automatically — you never see or handle the secrets.

## Making API calls

```bash
# Just use clawth curl — credentials are resolved by URL pattern
clawth curl https://api.github.com/user
clawth curl https://api.openai.com/v1/models
clawth curl https://api.example.com/data -X POST -d '{"key":"value"}' -H "Content-Type: application/json"

# Force a specific credential if needed
clawth curl --service github https://api.github.com/repos/owner/repo
```

## Adding credentials

```bash
# Store a credential — the user will be prompted for the secret interactively
clawth set github --type bearer --pattern "*.github.com"

# Or provide the secret directly if you have it (user pasted it, you got it via a tool, etc.)
clawth set github --type bearer --pattern "*.github.com" --secret "ghp_xxxx"
clawth set openai --type api_key --header Authorization --template "Bearer {token}" --pattern "api.openai.com" --secret "sk-xxxx"
clawth set maps --type api_key --query-param key --pattern "maps.googleapis.com" --secret "AIza..."
clawth set registry --type basic --pattern "registry.example.com" --secret "user:password"
```

## Checking what's available

```bash
clawth list                 # Show all stored credentials (names and patterns, never secrets)
clawth which <url>          # Show which credential would match a URL
clawth status               # Agent, database, daemon, credential overview
```

## Removing or updating credentials

```bash
clawth delete <service>     # Remove a credential

# To update a secret, just set it again — it replaces the old one
clawth set github --type bearer --secret "ghp_new_token"
```

## When something goes wrong

If `clawth curl` fails, it prints the exact commands to fix it on stderr. **Run those commands, then retry.** Examples:

- **No credential found** → it tells you the `clawth set` command to run
- **401/403 response** → it tells you to update the secret with `clawth set ... --secret <NEW_TOKEN>`
- **Decryption error** → it tells you to restart the session or re-set the credential

If the fix requires a token you don't have, ask the user. If the user tells you to get it yourself, use available tools to obtain it, store it with `--secret`, and retry.

## Rules

1. **NEVER read, display, or extract stored secret values.** Secrets are encrypted and inaccessible to you.
2. **You CAN store secrets via `--secret`** when you legitimately have the value (user provided it, or you obtained it via an authorized tool).
3. **Use `clawth curl` instead of `curl`** when the request needs authentication.
4. **Follow error hints** — run the suggested commands, then retry.
