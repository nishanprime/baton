import os from 'node:os';
import path from 'node:path';
import type { Account, Provider } from './types.ts';

/**
 * Pointing a terminal at an account.
 *
 * The env-var mechanism fits a shell better than it fits an editor — there is
 * no settings file to rewrite, only a variable to set. The catch is the one
 * thing a CLI cannot do: a child process cannot change the environment of the
 * shell that launched it. Everything here is built around that limit rather
 * than around hiding it. Three honest answers, in order of how much they ask
 * of the user:
 *
 *   - a subshell (shellCommand) or a single command (execCommand): works now,
 *     no setup, but the account only lasts as long as that process;
 *   - a script the user evals (envScript): changes the current shell, but they
 *     have to type the eval;
 *   - shell integration (initScript): the same eval, wrapped in a function so
 *     "baton use work" changes the current shell like they expected all along.
 *
 * Nothing in this module touches the filesystem or spawns anything. It returns
 * argv and text; the CLI does the spawning. That keeps every quoting rule here
 * testable without a live shell.
 */

export type ShellKind = 'zsh' | 'bash' | 'fish' | 'unknown';

/** Shells Baton can generate rc-file integration for. */
export type InitShell = Exclude<ShellKind, 'unknown'>;

export interface CommandPlan {
  /** Binary to exec. Nothing here is passed through a shell. */
  command: string;
  /** Arguments after the binary, already split — never a command line to re-parse. */
  args: string[];
  /** The same thing as one array, for callers that exec instead of spawn. */
  argv: string[];
  /** Variables to layer on top of the parent environment. */
  env: Record<string, string>;
}

export interface ShellPlan extends CommandPlan {
  /** Which shell family the binary belongs to, so the caller can report it. */
  shell: ShellKind;
}

export interface SpawnOptions {
  /** Shell binary to use. Defaults to $SHELL, then a per-platform fallback. */
  shellPath?: string;
  /** Start it as a login shell as well as an interactive one. */
  login?: boolean;
  /** Environment to read $SHELL from. Defaults to the current process env. */
  env?: EnvLike;
}

type EnvLike = Record<string, string | undefined>;

const plan = (command: string, args: string[], env: Record<string, string>): CommandPlan => ({
  command,
  args,
  argv: [command, ...args],
  env,
});

/**
 * Marks which account a shell is running under, for prompts and for
 * "baton status" to describe the terminal it was typed into. The provider is
 * recorded alongside it because the account id alone is ambiguous once a
 * second provider exists — two providers can both have an account called
 * "work", each meaning a different directory.
 */
export const ACCOUNT_ENV_VAR = 'BATON_ACCOUNT';
export const PROVIDER_ENV_VAR = 'BATON_PROVIDER';

/** Said in --help and after a plain "baton use", so the limit never surprises. */
export const PARENT_SHELL_NOTE =
  'A command cannot change the environment of the shell that started it. ' +
  'To switch the terminal you are typing in, add the shell integration ' +
  '("baton init <shell>") to your rc file, or run: eval "$(baton env <account>)". ' +
  'Without either, "baton shell <account>" opens a subshell on that account and ' +
  '"baton exec <account> -- <cmd>" runs one command under it.';

/** The variables a session needs to be on this account. */
export function buildEnv(provider: Provider, account: Account): Record<string, string> {
  return {
    [provider.envVar]: account.configDir,
    [ACCOUNT_ENV_VAR]: account.id,
    [PROVIDER_ENV_VAR]: provider.id,
  };
}

/** Which shell family a binary path belongs to. */
export function shellKindFor(shellPath: string | undefined): ShellKind {
  if (!shellPath) return 'unknown';
  // Trailing version digits are real: Homebrew installs bash 5 as bash-5.2.
  const base = path.basename(shellPath).replace(/\.exe$/i, '').replace(/-?[\d.]+$/, '');
  if (base === 'zsh') return 'zsh';
  if (base === 'bash' || base === 'sh') return 'bash';
  if (base === 'fish') return 'fish';
  return 'unknown';
}

/**
 * The user's shell, from $SHELL.
 *
 * $SHELL is the login shell, not necessarily the one running right now, but it
 * is the only thing a child process can see without inspecting its parent, and
 * it is the shell whose rc file the integration goes into — which is what
 * callers actually want it for.
 */
export function detectShell(env: EnvLike = process.env): ShellKind {
  return shellKindFor(env.SHELL);
}

function fallbackShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
}

/**
 * An interactive subshell running under one account.
 *
 * This is the answer that needs no setup: the account lasts for the life of
 * the subshell and "exit" puts the user back where they were.
 */
export function shellCommand(
  provider: Provider,
  account: Account,
  opts: SpawnOptions = {},
): ShellPlan {
  const env = opts.env ?? process.env;
  const shellPath = opts.shellPath ?? env.SHELL ?? fallbackShell();
  const shell = shellKindFor(shellPath);

  // cmd.exe and PowerShell have no -i; they are interactive when given a
  // console. Passing POSIX flags there fails outright, so pass none.
  const args =
    process.platform === 'win32' && shell === 'unknown'
      ? []
      : opts.login
        ? ['-l', '-i']
        : ['-i'];

  return { ...plan(shellPath, args, buildEnv(provider, account)), shell };
}

/**
 * One command under one account.
 *
 * argv is exec'd directly rather than handed to a shell, so an argument
 * containing spaces or quotes needs no escaping and cannot be re-split.
 */
export function execCommand(
  provider: Provider,
  account: Account,
  argv: string[],
): CommandPlan {
  if (!argv.length) {
    throw new Error(`Nothing to run. Usage: baton exec ${account.id} -- <command> [args...]`);
  }
  return plan(argv[0]!, argv.slice(1), buildEnv(provider, account));
}

/**
 * Quote for POSIX shells.
 *
 * Single quotes, because inside them every character is literal — a config dir
 * may contain a space, a dollar sign or a backtick, and only the single quote
 * itself needs the close-escape-reopen dance.
 */
function posixQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Quote for fish, which does not have the close-escape-reopen trick: inside
 * fish single quotes, a backslash and a quote are the only two characters that
 * mean anything, and both are escaped with a backslash.
 */
function fishQuote(value: string): string {
  return `'${value.split('\\').join('\\\\').split("'").join("\\'")}'`;
}

const assign = (shell: ShellKind, name: string, value: string): string =>
  shell === 'fish'
    ? `set -gx ${name} ${fishQuote(value)}`
    : `export ${name}=${posixQuote(value)}`;

/** Lines to eval in the current shell, as printed by "baton env <account>". */
export function envScript(
  provider: Provider,
  account: Account,
  shell: ShellKind = detectShell(),
): string {
  const env = buildEnv(provider, account);
  const lines = Object.entries(env).map(([name, value]) => assign(shell, name, value));
  return `# baton: ${provider.id} on ${account.id}\n${lines.join('\n')}\n`;
}

/**
 * The reverse: drop back to the provider's implicit default directory. Unset
 * rather than set-to-default, because an unset variable is what a fresh shell
 * looks like and the provider already knows where to go without it.
 */
export function envUnsetScript(
  provider: Provider,
  shell: ShellKind = detectShell(),
): string {
  const names = [provider.envVar, ACCOUNT_ENV_VAR, PROVIDER_ENV_VAR];
  const lines = names.map((n) => (shell === 'fish' ? `set -e ${n}` : `unset ${n}`));
  return `# baton: ${provider.id} back to its default account\n${lines.join('\n')}\n`;
}

/**
 * Subcommands the completions offer. Kept here rather than imported from the
 * CLI so this module stays free of the CLI's argument parsing; an id that
 * drifts costs a missing completion, not a broken command.
 */
const COMMANDS = [
  'status', 'setup', 'add', 'use', 'link', 'unlink', 'alias', 'settings',
  'history', 'autoswitch', 'doctor', 'env', 'shell', 'exec', 'init', 'help',
];

/** Subcommands whose first bare argument is an account id. */
const ACCOUNT_COMMANDS = ['use', 'env', 'shell', 'exec', 'alias', 'link', 'unlink'];

/**
 * The wrapper's contract with the binary.
 *
 * "--shell <kind>" names the shell family to write for, and means: put the
 * eval-able script on stdout, put everything meant for a human on stderr. That
 * split is what lets the wrapper capture one without swallowing the other.
 *
 * It is appended after the user's arguments, never before: the CLI reads the
 * account from the first bare argument, and a flag's value sitting in front of
 * it would be taken for the account name.
 */
const EMIT_FLAG = '--shell';

function posixInit(shell: 'zsh' | 'bash'): string {
  const completion = shell === 'zsh' ? zshCompletion() : bashCompletion();
  const promptVar = shell === 'zsh' ? 'PROMPT' : 'PS1';
  const promptSetup = shell === 'zsh' ? '#   setopt PROMPT_SUBST\n' : '';

  return `# baton shell integration (${shell}).
# Add to your rc file with:  eval "$(baton init ${shell})"

# A child process cannot change this shell's environment, so the two
# subcommands that need to are run here and eval'd, and everything else is
# handed to the real binary untouched — same output, same exit code.
baton() {
  local __baton_cmd __baton_out __baton_rc __baton_arg
  if [ \$# -eq 0 ]; then
    command baton
    return \$?
  fi
  case "\$1" in
    use|env) ;;
    *) command baton "\$@"; return \$? ;;
  esac
  # Help is documentation, not a switch: it must reach the binary as typed.
  for __baton_arg in "\$@"; do
    case "\$__baton_arg" in
      -h|--help) command baton "\$@"; return \$? ;;
    esac
  done
  __baton_cmd="\$1"
  shift
  __baton_out="\$(command baton "\$__baton_cmd" "\$@" ${EMIT_FLAG} ${shell})"
  __baton_rc=\$?
  if [ "\$__baton_rc" -eq 0 ] && [ -n "\$__baton_out" ]; then
    eval "\$__baton_out"
  fi
  return "\$__baton_rc"
}

# Prints the active account, or nothing when the shell is on the default.
# Show it in your prompt with:
${promptSetup}#   ${promptVar}='\$(baton_prompt) '"\$${promptVar}"
baton_prompt() {
  if [ -z "\${${ACCOUNT_ENV_VAR}-}" ]; then
    return 0
  fi
  printf '%s%s%s' "\${BATON_PROMPT_PREFIX-[}" "\$${ACCOUNT_ENV_VAR}" "\${BATON_PROMPT_SUFFIX-]}"
}

${completion}`;
}

function zshCompletion(): string {
  return `_baton() {
  if (( CURRENT == 2 )); then
    compadd -- ${COMMANDS.join(' ')}
  elif [[ "\$words[2]" == (${ACCOUNT_COMMANDS.join('|')}) ]]; then
    # Silent and optional: an older binary without this subcommand simply
    # offers no account names rather than printing an error mid-completion.
    compadd -- \${(f)"\$(command baton accounts --ids 2>/dev/null)"}
  fi
}
if (( \${+functions[compdef]} )); then
  compdef _baton baton
fi
`;
}

function bashCompletion(): string {
  return `_baton_complete() {
  local __baton_cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${COMMANDS.join(' ')}" -- "\$__baton_cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
    ${ACCOUNT_COMMANDS.join('|')})
      # Silent and optional: an older binary without this subcommand simply
      # offers no account names rather than printing an error mid-completion.
      COMPREPLY=( \$(compgen -W "\$(command baton accounts --ids 2>/dev/null)" -- "\$__baton_cur") ) ;;
    *) COMPREPLY=() ;;
  esac
}
if [ -n "\${BASH_VERSION-}" ]; then
  complete -F _baton_complete baton
fi
`;
}

function fishInit(): string {
  return `# baton shell integration (fish).
# Add to ~/.config/fish/config.fish with:  baton init fish | source

# A child process cannot change this shell's environment, so the two
# subcommands that need to are run here and sourced, and everything else is
# handed to the real binary untouched — same output, same exit code.
function baton --description 'baton, with use and env applied to this shell'
    if test (count \$argv) -eq 0
        command baton
        return \$status
    end
    switch \$argv[1]
        case use env
            # Help is documentation, not a switch: it must reach the binary as typed.
            if contains -- -h \$argv; or contains -- --help \$argv
                command baton \$argv
                return \$status
            end
            set -l __baton_cmd \$argv[1]
            set -e argv[1]
            set -l __baton_out (command baton \$__baton_cmd \$argv ${EMIT_FLAG} fish | string collect)
            set -l __baton_rc \$pipestatus[1]
            if test \$__baton_rc -eq 0; and test -n "\$__baton_out"
                echo \$__baton_out | source
            end
            return \$__baton_rc
        case '*'
            command baton \$argv
            return \$status
    end
end

# Prints the active account, or nothing when the shell is on the default.
# Call it from your own fish_prompt.
function baton_prompt --description 'Active baton account, for a prompt'
    if test -z "\$${ACCOUNT_ENV_VAR}"
        return 0
    end
    set -l __baton_prefix '['
    set -l __baton_suffix ']'
    if set -q BATON_PROMPT_PREFIX
        set __baton_prefix \$BATON_PROMPT_PREFIX
    end
    if set -q BATON_PROMPT_SUFFIX
        set __baton_suffix \$BATON_PROMPT_SUFFIX
    end
    printf '%s%s%s' \$__baton_prefix \$${ACCOUNT_ENV_VAR} \$__baton_suffix
end

complete -c baton -f
complete -c baton -n __fish_use_subcommand -a '${COMMANDS.join(' ')}'
# Silent and optional: an older binary without this subcommand simply offers
# no account names rather than printing an error mid-completion.
complete -c baton -n '__fish_seen_subcommand_from ${ACCOUNT_COMMANDS.join(' ')}' -a '(command baton accounts --ids 2>/dev/null)'
`;
}

/** Shell integration for an rc file, as printed by "baton init <shell>". */
export function initScript(shell: InitShell): string {
  switch (shell) {
    case 'zsh':
    case 'bash':
      return posixInit(shell);
    case 'fish':
      return fishInit();
    default: {
      const bad: never = shell;
      throw new Error(
        `No shell integration for "${String(bad)}". Supported: zsh, bash, fish.`,
      );
    }
  }
}

/** Where that integration conventionally goes. */
export function rcFile(shell: InitShell, home = os.homedir()): string {
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zshrc');
    case 'bash':
      // macOS terminals start login shells, which read .bash_profile and never
      // .bashrc unless the user wired one to the other.
      return path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
    case 'fish':
      return path.join(home, '.config', 'fish', 'config.fish');
  }
}

/** The single line to add to that file. */
export function initHint(shell: InitShell): string {
  return shell === 'fish' ? 'baton init fish | source' : `eval "$(baton init ${shell})"`;
}

/**
 * Which account this process is running under.
 *
 * Resolving by directory rather than by the marker: the variable is what the
 * provider actually reads, and it may have been set by an editor, by a rc
 * file, or by hand, none of which leave a marker behind. The marker is the
 * fallback for a directory Baton does not recognise as an account.
 */
export function currentAccountFromEnv(
  provider: Provider,
  accounts: Account[] = [],
  env: EnvLike = process.env,
): string | null {
  const configDir = env[provider.envVar];
  if (!configDir) {
    // Unset means the provider falls back to its implicit directory, so this
    // process is on the default account whether or not anyone chose it.
    return accounts.find((a) => a.isDefault)?.id ?? null;
  }

  const resolved = path.resolve(configDir);
  const match = accounts.find((a) => path.resolve(a.configDir) === resolved);
  if (match) return match.id;

  const marker = env[ACCOUNT_ENV_VAR];
  if (marker && env[PROVIDER_ENV_VAR] === provider.id) return marker;
  return null;
}
