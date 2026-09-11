import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_ENV_VAR,
  PROVIDER_ENV_VAR,
  buildEnv,
  currentAccountFromEnv,
  detectShell,
  envScript,
  envUnsetScript,
  execCommand,
  initHint,
  initScript,
  rcFile,
  shellCommand,
  shellKindFor,
  type InitShell,
} from '../src/core/terminal.ts';
import type { Account, Provider } from '../src/core/types.ts';

const provider = {
  id: 'claude',
  label: 'Claude Code',
  envVar: 'CLAUDE_CONFIG_DIR',
  sharePolicy: { shared: [], private: [], merged: [] },
  discoverAccounts: () => [],
  discoverHosts: () => [],
  bindHost: () => '',
} satisfies Provider;

const account = (id: string, configDir: string, isDefault = false): Account => ({
  id,
  label: id,
  configDir,
  isDefault,
  providerId: 'claude',
});

/** Directory names that have broken naive quoting, including one this user owns. */
const NASTY_DIRS = [
  '/Users/x/.claude-testing new',
  "/Users/x/.claude-o'brien",
  '/Users/x/.claude-$HOME `whoami` "dq"',
  '/Users/x/.claude-back\\slash',
];

function binOnPath(name: string): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const SHELL_BIN: Record<InitShell, string | null> = {
  zsh: binOnPath('zsh'),
  bash: binOnPath('bash'),
  fish: binOnPath('fish'),
};

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `baton-terminal-${tag}-`));
}

// ------------------------------------------------------------------ env

test('buildEnv points the provider var at the account and leaves a marker', () => {
  const env = buildEnv(provider, account('work', '/Users/x/.claude-work'));
  assert.deepEqual(env, {
    CLAUDE_CONFIG_DIR: '/Users/x/.claude-work',
    [ACCOUNT_ENV_VAR]: 'work',
    [PROVIDER_ENV_VAR]: 'claude',
  });
});

test('buildEnv carries nothing else — no credentials, no whole environment', () => {
  const env = buildEnv(provider, account('work', '/Users/x/.claude-work'));
  assert.equal(Object.keys(env).length, 3);
});

// ------------------------------------------------------------------ shell detection

test('shellKindFor reads the family out of a binary path', () => {
  assert.equal(shellKindFor('/bin/zsh'), 'zsh');
  assert.equal(shellKindFor('/bin/bash'), 'bash');
  assert.equal(shellKindFor('/usr/local/bin/fish'), 'fish');
  assert.equal(shellKindFor('/opt/homebrew/bin/bash-5.2'), 'bash');
  assert.equal(shellKindFor('/bin/sh'), 'bash');
  assert.equal(shellKindFor('C:\\Windows\\System32\\cmd.exe'), 'unknown');
  assert.equal(shellKindFor('/usr/bin/nu'), 'unknown');
  assert.equal(shellKindFor(undefined), 'unknown');
  assert.equal(shellKindFor(''), 'unknown');
});

test('detectShell reads $SHELL and does not guess when it is missing', () => {
  assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh');
  assert.equal(detectShell({ SHELL: '/usr/bin/fish' }), 'fish');
  assert.equal(detectShell({}), 'unknown');
});

// ------------------------------------------------------------------ spawn plans

test('shellCommand asks for an interactive shell with the account env', () => {
  const plan = shellCommand(provider, account('work', '/Users/x/.claude-work'), {
    env: { SHELL: '/bin/zsh' },
  });
  assert.deepEqual(plan.argv, ['/bin/zsh', '-i']);
  assert.equal(plan.command, '/bin/zsh');
  assert.deepEqual(plan.args, ['-i']);
  assert.equal(plan.shell, 'zsh');
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, '/Users/x/.claude-work');
});

test('shellCommand honours --login and an explicit shell path', () => {
  const plan = shellCommand(provider, account('work', '/Users/x/.claude-work'), {
    env: { SHELL: '/bin/zsh' },
    shellPath: '/usr/local/bin/fish',
    login: true,
  });
  assert.deepEqual(plan.argv, ['/usr/local/bin/fish', '-l', '-i']);
  assert.equal(plan.shell, 'fish');
});

test('shellCommand falls back when $SHELL is unset rather than throwing', () => {
  const plan = shellCommand(provider, account('work', '/Users/x/.claude-work'), { env: {} });
  assert.ok(plan.argv[0], 'still has something to exec');
  assert.equal(plan.argv.length > 0, true);
});

test('execCommand passes argv through untouched, so no quoting can go wrong', () => {
  const plan = execCommand(provider, account('work', '/Users/x/.claude-work'), [
    'claude',
    '-p',
    'summarise this file, "carefully"',
  ]);
  assert.deepEqual(plan.argv, ['claude', '-p', 'summarise this file, "carefully"']);
  assert.equal(plan.command, 'claude');
  assert.deepEqual(plan.args, ['-p', 'summarise this file, "carefully"']);
  assert.equal(plan.env[ACCOUNT_ENV_VAR], 'work');
});

test('execCommand refuses an empty command instead of spawning a shell', () => {
  assert.throws(
    () => execCommand(provider, account('work', '/Users/x/.claude-work'), []),
    /baton exec work -- <command>/,
  );
});

// ------------------------------------------------------------------ env script syntax

test('envScript uses export for posix shells and set -gx for fish', () => {
  const acct = account('work', '/Users/x/.claude-work');
  assert.match(envScript(provider, acct, 'zsh'), /^export CLAUDE_CONFIG_DIR='\/Users\/x\/\.claude-work'$/m);
  assert.match(envScript(provider, acct, 'bash'), /^export BATON_ACCOUNT='work'$/m);
  assert.match(envScript(provider, acct, 'fish'), /^set -gx CLAUDE_CONFIG_DIR '\/Users\/x\/\.claude-work'$/m);
  assert.doesNotMatch(envScript(provider, acct, 'fish'), /export/);
});

test('envScript quotes a directory with a space', () => {
  const acct = account('work', '/Users/x/.claude-testing new');
  assert.match(envScript(provider, acct, 'bash'), /'\/Users\/x\/\.claude-testing new'/);
  assert.match(envScript(provider, acct, 'fish'), /'\/Users\/x\/\.claude-testing new'/);
});

test('envScript escapes quotes the way each shell family wants', () => {
  const acct = account('work', "/Users/x/.claude-o'brien");
  // posix: close, escaped quote, reopen.
  assert.match(envScript(provider, acct, 'bash'), /'\/Users\/x\/\.claude-o'\\''brien'/);
  // fish: backslash, because it has no close-escape-reopen form.
  assert.match(envScript(provider, acct, 'fish'), /'\/Users\/x\/\.claude-o\\'brien'/);
});

test('envScript escapes backslashes for fish, which treats them as escapes', () => {
  const acct = account('work', '/Users/x/.claude-back\\slash');
  assert.match(envScript(provider, acct, 'fish'), /'\/Users\/x\/\.claude-back\\\\slash'/);
});

test('envUnsetScript uses the right removal verb per shell', () => {
  assert.match(envUnsetScript(provider, 'zsh'), /^unset CLAUDE_CONFIG_DIR$/m);
  assert.match(envUnsetScript(provider, 'fish'), /^set -e CLAUDE_CONFIG_DIR$/m);
});

test('an unknown shell still gets posix output rather than nothing', () => {
  const acct = account('work', '/Users/x/.claude-work');
  assert.match(envScript(provider, acct, 'unknown'), /^export CLAUDE_CONFIG_DIR=/m);
});

// ------------------------------------------------------------------ env script, run for real

/** Source the script in a real shell and read the variable back out. */
function roundTrip(shell: InitShell, bin: string, dir: string): string {
  const file = path.join(tmpdir('env'), shell === 'fish' ? 'env.fish' : 'env.sh');
  fs.writeFileSync(file, envScript(provider, account('work', dir), shell), 'utf8');
  const argv =
    shell === 'fish'
      ? ['-c', 'source $argv[1]; printf %s "$CLAUDE_CONFIG_DIR"', 'fish', file]
      : ['-c', 'eval "$(cat "$1")"; printf %s "$CLAUDE_CONFIG_DIR"', '_', file];
  return execFileSync(bin, argv, { encoding: 'utf8' });
}

for (const shell of ['bash', 'zsh', 'fish'] as InitShell[]) {
  test(`${shell} reads back every awkward directory name exactly`, { skip: !SHELL_BIN[shell] }, () => {
    for (const dir of NASTY_DIRS) {
      assert.equal(roundTrip(shell, SHELL_BIN[shell]!, dir), dir, `${shell}: ${dir}`);
    }
  });
}

// ------------------------------------------------------------------ init script

test('initScript names the shell it is for and explains why it exists', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as InitShell[]) {
    const script = initScript(shell);
    assert.match(script, new RegExp(`\\(${shell}\\)`));
    assert.match(script, /cannot change this shell's environment/);
    assert.match(script, /baton_prompt/);
  }
});

test('initScript wraps the two subcommands that must run here, and only those', () => {
  const script = initScript('zsh');
  assert.match(script, /use\|env/);
  assert.match(script, /command baton "\$@"/); // the passthrough arm
  assert.match(script, /--shell zsh/);
});

test('the shell flag goes after the user arguments, never in front of them', () => {
  // The CLI reads the account from the first bare argument, so a flag value
  // placed first would be taken for the account name.
  for (const shell of ['zsh', 'bash'] as InitShell[]) {
    assert.match(initScript(shell), /"\$@" --shell/);
  }
  assert.match(initScript('fish'), /\$argv --shell fish/);
});

test('initScript refuses a shell it has no integration for', () => {
  assert.throws(() => initScript('unknown' as InitShell), /Supported: zsh, bash, fish/);
});

test('initHint and rcFile match the shell they describe', () => {
  assert.equal(initHint('fish'), 'baton init fish | source');
  assert.equal(initHint('zsh'), 'eval "$(baton init zsh)"');
  assert.equal(rcFile('zsh', '/Users/x'), '/Users/x/.zshrc');
  assert.equal(rcFile('fish', '/Users/x'), '/Users/x/.config/fish/config.fish');
});

for (const shell of ['bash', 'zsh', 'fish'] as InitShell[]) {
  test(`${shell} parses its own init script`, { skip: !SHELL_BIN[shell] }, () => {
    const file = path.join(tmpdir('init'), shell === 'fish' ? 'init.fish' : 'init.sh');
    fs.writeFileSync(file, initScript(shell), 'utf8');
    // -n / --no-execute: parse the whole file, run none of it.
    execFileSync(SHELL_BIN[shell]!, ['-n', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
}

// ------------------------------------------------------------------ the wrapper, run for real

/**
 * A stand-in for the real binary: it records the argv it was handed, answers
 * help itself, and prints an env script on stdout the way --shell says to.
 */
function fakeBaton(dir: string): void {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
for a in "$@"; do
  case "$a" in
    -h|--help) echo "HELP TEXT"; exit 0 ;;
  esac
done
case "$1" in
  use|env)
    echo "human output" >&2
    if [ -n "$FAKE_FAIL" ]; then exit 3; fi
    echo "export CLAUDE_CONFIG_DIR='/Users/x/.claude-testing new'"
    echo "export BATON_ACCOUNT='work'"
    ;;
  *) echo "passthrough"; exit "\${FAKE_RC:-0}" ;;
esac
`;
  const file = path.join(dir, 'baton');
  fs.writeFileSync(file, script, 'utf8');
  fs.chmodSync(file, 0o755);
}

interface Run {
  stdout: string;
  /** Every argv the fake binary was handed, one line each. */
  log: string[];
}

/** Source the init script in a real shell, run one command, report what happened. */
function runWrapped(shell: 'zsh' | 'bash', command: string, env: Record<string, string> = {}): Run {
  const dir = tmpdir('wrap');
  fakeBaton(dir);
  const init = path.join(dir, 'init.sh');
  const log = path.join(dir, 'log');
  fs.writeFileSync(init, initScript(shell), 'utf8');
  fs.writeFileSync(log, '', 'utf8');

  const res = execFileSync(
    SHELL_BIN[shell]!,
    ['-c', `eval "$(cat "$1")"; shift; ${command}`, '_', init],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        FAKE_LOG: log,
        CLAUDE_CONFIG_DIR: '',
        BATON_ACCOUNT: '',
      },
    },
  );
  return { stdout: res, log: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

for (const shell of ['bash', 'zsh'] as const) {
  test(`${shell} wrapper applies env to the current shell`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton env work; printf "rc=%s acct=%s dir=%s" "$?" "$BATON_ACCOUNT" "$CLAUDE_CONFIG_DIR"');
    assert.match(run.stdout, /rc=0 acct=work dir=\/Users\/x\/\.claude-testing new/);
    assert.deepEqual(run.log, [`env work --shell ${shell}`]);
  });

  test(`${shell} wrapper does NOT intercept use`, { skip: !SHELL_BIN[shell] }, () => {
    // use rebinds editors, not this shell. Evaluating its output would at best
    // print a parse error and at worst rewrite every editor's settings while
    // the user was asking about one terminal tab.
    const run = runWrapped(shell, 'baton use work; printf "rc=%s acct=[%s]" "$?" "$BATON_ACCOUNT"');
    assert.deepEqual(run.log, ['use work'], 'reaches the binary unmodified, with no --shell');
    assert.match(run.stdout, /acct=\[\]/, 'this shell is left alone');
  });

  test(`${shell} wrapper passes other subcommands straight through`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton status; printf "rc=%s" "$?"');
    assert.match(run.stdout, /passthrough/);
    assert.match(run.stdout, /rc=0/);
    assert.deepEqual(run.log, ['status']);
  });

  test(`${shell} wrapper keeps a passthrough exit code`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton doctor >/dev/null; printf "rc=%s" "$?"', { FAKE_RC: '7' });
    assert.match(run.stdout, /rc=7/);
  });

  test(`${shell} wrapper keeps a failing env's exit code and evals nothing`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton env work; printf "rc=%s acct=[%s]" "$?" "$BATON_ACCOUNT"', { FAKE_FAIL: '1' });
    assert.match(run.stdout, /rc=3 acct=\[\]/);
  });

  test(`${shell} wrapper leaves --help alone`, { skip: !SHELL_BIN[shell] }, () => {
    const help = runWrapped(shell, 'baton --help');
    assert.match(help.stdout, /HELP TEXT/);
    assert.deepEqual(help.log, ['--help']);

    // The interesting one: help for the subcommand the wrapper does intercept.
    // If it were eval'd, "HELP TEXT" would vanish into a command-not-found.
    const envHelp = runWrapped(shell, 'baton env --help');
    assert.match(envHelp.stdout, /HELP TEXT/);
    assert.deepEqual(envHelp.log, ['env --help']);
  });

  test(`${shell} wrapper handles a bare "baton"`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton; printf "rc=%s" "$?"');
    assert.match(run.stdout, /passthrough/);
    assert.match(run.stdout, /rc=0/);
  });

  test(`${shell} wrapper forwards flags and puts the emit flag last`, { skip: !SHELL_BIN[shell] }, () => {
    const run = runWrapped(shell, 'baton env work --provider claude >/dev/null 2>&1');
    assert.deepEqual(run.log, [`env work --provider claude --shell ${shell}`]);
  });

  test(`${shell} prompt helper is empty off-account and bracketed on one`, { skip: !SHELL_BIN[shell] }, () => {
    const off = runWrapped(shell, 'printf "[%s]" "$(baton_prompt)"');
    assert.match(off.stdout, /^\[\]/);
    const on = runWrapped(shell, 'baton env work >/dev/null 2>&1; printf "%s" "$(baton_prompt)"');
    assert.match(on.stdout, /\[work\]/);
  });
}

// ------------------------------------------------------------------ reading it back

test('currentAccountFromEnv resolves the config dir to an account', () => {
  const accounts = [account('default', '/Users/x/.claude', true), account('work', '/Users/x/.claude-work')];
  assert.equal(
    currentAccountFromEnv(provider, accounts, { CLAUDE_CONFIG_DIR: '/Users/x/.claude-work' }),
    'work',
  );
  // Trailing slashes and dot segments are the same directory.
  assert.equal(
    currentAccountFromEnv(provider, accounts, { CLAUDE_CONFIG_DIR: '/Users/x/./.claude-work/' }),
    'work',
  );
});

test('an unset variable means the provider default, not "no account"', () => {
  const accounts = [account('default', '/Users/x/.claude', true), account('work', '/Users/x/.claude-work')];
  assert.equal(currentAccountFromEnv(provider, accounts, {}), 'default');
  assert.equal(currentAccountFromEnv(provider, [], {}), null);
});

test('the marker names an account whose directory is not on this machine', () => {
  assert.equal(
    currentAccountFromEnv(provider, [], {
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-elsewhere',
      [ACCOUNT_ENV_VAR]: 'elsewhere',
      [PROVIDER_ENV_VAR]: 'claude',
    }),
    'elsewhere',
  );
});

test("another provider's marker is not read as this provider's account", () => {
  assert.equal(
    currentAccountFromEnv(provider, [], {
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-elsewhere',
      [ACCOUNT_ENV_VAR]: 'work',
      [PROVIDER_ENV_VAR]: 'codex',
    }),
    null,
  );
});

test('a hand-set directory Baton does not know reports nothing rather than a guess', () => {
  const accounts = [account('work', '/Users/x/.claude-work')];
  assert.equal(
    currentAccountFromEnv(provider, accounts, { CLAUDE_CONFIG_DIR: '/tmp/somewhere-else' }),
    null,
  );
});

test('the env a subshell is given reads back as that account', () => {
  const acct = account('work', '/Users/x/.claude-testing new');
  const plan = shellCommand(provider, acct, { env: { SHELL: '/bin/zsh' } });
  assert.equal(currentAccountFromEnv(provider, [acct], plan.env), 'work');
});
