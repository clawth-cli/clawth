const BASH_COMPLETION = `
_clawth_completions() {
  local cur prev commands services
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="setup init set list delete curl login session status which check audit export import completion"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    delete|check|login)
      services=$(clawth list 2>/dev/null | tail -n +3 | awk '{print $1}')
      COMPREPLY=( $(compgen -W "\${services}" -- "\${cur}") )
      ;;
    set)
      case "\${prev}" in
        --type|-t)
          COMPREPLY=( $(compgen -W "api_key bearer basic oauth2 oauth2_pkce jwt aws_sigv4 p12 service_account" -- "\${cur}") )
          ;;
        *)
          COMPREPLY=( $(compgen -W "--type --header --query-param --pattern --template --secret --token-url --authorize-url --client-id --scopes --algorithm --issuer --audience --expiry-seconds --custom-claims --region --aws-service --session-token" -- "\${cur}") )
          ;;
      esac
      ;;
    session)
      COMPREPLY=( $(compgen -W "start stop" -- "\${cur}") )
      ;;
    audit)
      COMPREPLY=( $(compgen -W "--last --usage" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
  esac
}
complete -F _clawth_completions clawth
`.trim();

const ZSH_COMPLETION = `
#compdef clawth

_clawth() {
  local -a commands
  commands=(
    'setup:Initialize database, install skill, start daemon'
    'init:Create encrypted database and set passphrase'
    'set:Store a credential'
    'list:List stored credentials'
    'delete:Remove a credential'

    'curl:Execute curl with auth injected'
    'login:OAuth2 PKCE browser login flow'
    'session:Manage passphrase cache daemon'
    'status:Show current configuration and state'
    'which:Show which credential matches a URL'
    'check:Verify credentials can be decrypted'
    'audit:View audit log and usage stats'
    'export:Export credentials to encrypted file'
    'import:Import credentials from encrypted file'
    'completion:Generate shell completions'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        delete|check|login)
          local services
          services=(\${(f)"$(clawth list 2>/dev/null | tail -n +3 | awk '{print $1}')"})
          _describe 'service' services
          ;;
        set)
          _arguments \\
            '--type[Credential type]:type:(api_key bearer basic oauth2 oauth2_pkce jwt aws_sigv4 p12 service_account)' \\
            '--header[Header name]' \\
            '--pattern[URL pattern glob]' \\
            '--secret[Secret value]' \\
            '--template[Injection template]'
          ;;
        session)
          _values 'action' start stop
          ;;
        completion)
          _values 'shell' bash zsh fish
          ;;
      esac
      ;;
  esac
}

_clawth
`.trim();

const FISH_COMPLETION = `
complete -c clawth -n '__fish_use_subcommand' -a setup -d 'Initialize database, install skill, start daemon'
complete -c clawth -n '__fish_use_subcommand' -a init -d 'Create encrypted database'
complete -c clawth -n '__fish_use_subcommand' -a set -d 'Store a credential'
complete -c clawth -n '__fish_use_subcommand' -a list -d 'List stored credentials'
complete -c clawth -n '__fish_use_subcommand' -a delete -d 'Remove a credential'

complete -c clawth -n '__fish_use_subcommand' -a curl -d 'Execute curl with auth injected'
complete -c clawth -n '__fish_use_subcommand' -a login -d 'OAuth2 PKCE login flow'
complete -c clawth -n '__fish_use_subcommand' -a session -d 'Manage passphrase cache daemon'
complete -c clawth -n '__fish_use_subcommand' -a status -d 'Show configuration and state'
complete -c clawth -n '__fish_use_subcommand' -a which -d 'Show which credential matches a URL'
complete -c clawth -n '__fish_use_subcommand' -a check -d 'Verify credentials can be decrypted'
complete -c clawth -n '__fish_use_subcommand' -a audit -d 'View audit log and usage stats'
complete -c clawth -n '__fish_use_subcommand' -a export -d 'Export credentials'
complete -c clawth -n '__fish_use_subcommand' -a import -d 'Import credentials'
complete -c clawth -n '__fish_use_subcommand' -a completion -d 'Generate shell completions'
complete -c clawth -n '__fish_seen_subcommand_from session' -a 'start stop'
complete -c clawth -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c clawth -n '__fish_seen_subcommand_from set' -l type -a 'api_key bearer basic oauth2 oauth2_pkce jwt aws_sigv4 p12 service_account'
`.trim();

export function completionCommand(shell: string): void {
  switch (shell) {
    case "bash":
      console.log(BASH_COMPLETION);
      break;
    case "zsh":
      console.log(ZSH_COMPLETION);
      break;
    case "fish":
      console.log(FISH_COMPLETION);
      break;
    default:
      console.error(`Unknown shell: ${shell}. Use: bash, zsh, or fish`);
      process.exit(1);
  }
}
