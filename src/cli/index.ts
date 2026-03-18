import { Command } from "commander";
import { initCommand } from "./init.ts";
import { setCommand } from "./set.ts";
import { listCommand } from "./list.ts";
import { deleteCommand } from "./delete.ts";

import { curlCommand } from "./curl.ts";
import { loginCommand } from "./login.ts";
import { sessionCommand } from "./session.ts";
import { setupCommand } from "./setup.ts";
import { statusCommand } from "./status.ts";
import { whichCommand } from "./which.ts";
import { checkCommand } from "./check.ts";
import { auditCommand } from "./audit.ts";
import { exportCommand, importCommand } from "./import-export.ts";
import { completionCommand } from "./completion.ts";
import { credsCommand } from "./creds.ts";
import { setAgentId } from "../db/repository.ts";
import { configurePostgREST } from "../db/postgrest.ts";
import { loadConfig } from "../config/store.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(thisDir, "..", "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function applyConfig(): void {
  const cfg = loadConfig();
  setAgentId(cfg.agent);
  if (cfg.remote && cfg.remoteJwt) {
    configurePostgREST({ baseUrl: cfg.remote, jwt: cfg.remoteJwt });
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("clawth")
    .description(
      "CLI tool that lets Claude Code make authenticated API calls without ever seeing credentials",
    )
    .version(getVersion())
    .hook("preAction", () => {
      applyConfig();
    });

  // setup (default command when run with no args)
  program
    .command("setup", { isDefault: true })
    .description("Initialize database, install Claude Code skill, and start session daemon")
    .option("--passphrase <value>", "Encryption passphrase (default: auto-generated)")
    .option("--agent <id>", "Agent ID (default: default)")
    .option("--remote <url>", "PostgREST server URL for remote database")
    .option("--remote-jwt <path-or-token>", "JWT for PostgREST auth (file path or raw token)")
    .option("--no-skill", "Skip Claude Code skill installation")
    .option("--skill-dir <path>", "Custom skill install directory")
    .action(async (opts) => {
      await setupCommand(opts);
    });

  // init
  program
    .command("init")
    .description("Create encrypted database and set passphrase")
    .action(async () => {
      await initCommand();
    });

  // set
  program
    .command("set <service>")
    .description("Store a credential")
    .requiredOption(
      "-t, --type <type>",
      "Credential type (api_key, bearer, basic, oauth2, oauth2_pkce, jwt, aws_sigv4, p12, service_account)",
    )
    .option("--header <name>", "Header name for injection (default: Authorization)")
    .option("--query-param <name>", "Query parameter name for injection")
    .option("-p, --pattern <glob...>", "URL patterns to match (glob)")
    .option("--template <template>", "Injection template (e.g., 'Bearer {token}')")
    .option("--secret <value>", "Secret value (non-interactive, e.g., for automation)")
    .option("--token-url <url>", "OAuth2 token URL")
    .option("--authorize-url <url>", "OAuth2 authorize URL (PKCE)")
    .option("--client-id <id>", "OAuth2 client ID")
    .option("--scopes <scopes>", "OAuth2 scopes (space-separated)")
    .option("--algorithm <alg>", "JWT algorithm (RS256, HS256)")
    .option("--issuer <iss>", "JWT issuer claim")
    .option("--audience <aud>", "JWT audience claim")
    .option("--expiry-seconds <seconds>", "JWT expiry in seconds")
    .option("--custom-claims <json>", "JWT custom claims (JSON string)")
    .option("--region <region>", "AWS region")
    .option("--aws-service <service>", "AWS service name (e.g., s3, execute-api)")
    .option("--session-token <token>", "AWS session token")
    .action(async (service, opts) => {
      await setCommand(service, opts);
    });

  // list
  program
    .command("list")
    .description("List stored credentials (names and types only, never values)")
    .option("-v, --verbose", "Show detailed information")
    .action(async (opts) => {
      await listCommand(opts);
    });

  // delete
  program
    .command("delete <service>")
    .description("Remove a credential")
    .action(async (service) => {
      await deleteCommand(service);
    });

  // curl
  program
    .command("curl")
    .description("Execute curl with auth injected")
    .option("--service <name>", "Force a specific credential service")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (opts, cmd) => {
      const args = cmd.args as string[];
      await curlCommand(args, opts);
    });

  // login
  program
    .command("login <service>")
    .description("OAuth2 PKCE browser login flow")
    .action(async (service) => {
      await loginCommand(service);
    });

  // session
  program
    .command("session <action>")
    .description("Manage passphrase cache daemon (start/stop)")
    .action(async (action) => {
      await sessionCommand(action);
    });

  // status
  program
    .command("status")
    .description("Show current agent, database, session, and credential status")
    .action(async () => {
      await statusCommand();
    });

  // which
  program
    .command("which <url>")
    .description("Show which credential would match a URL")
    .action(async (url) => {
      await whichCommand(url);
    });

  // check
  program
    .command("check [service]")
    .description("Verify credentials can be decrypted and resolved")
    .action(async (service) => {
      await checkCommand(service);
    });

  // audit
  program
    .command("audit")
    .description("View audit log and per-service usage statistics")
    .option("--last <n>", "Show last N entries (default: 20)")
    .option("--usage", "Show per-service usage summary")
    .action(async (opts) => {
      await auditCommand(opts);
    });

  // export
  program
    .command("export <file>")
    .description("Export credentials to an encrypted file")
    .action(async (file) => {
      await exportCommand(file);
    });

  // import
  program
    .command("import <file>")
    .description("Import credentials from an encrypted file")
    .action(async (file) => {
      await importCommand(file);
    });

  // creds (interactive credential manager)
  program
    .command("creds")
    .description("Interactive credential manager — browse, add, update, remove")
    .action(async () => {
      await credsCommand();
    });

  // completion
  program
    .command("completion <shell>")
    .description("Generate shell completions (bash, zsh, fish)")
    .action((shell) => {
      completionCommand(shell);
    });

  return program;
}
