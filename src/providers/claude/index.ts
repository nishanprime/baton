import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, isDir, KNOWN_EDITORS, findExtensions } from '../../core/paths.ts';
import { discoverVsCodeHosts, bindVsCodeHost, type VsCodeBinding } from '../../core/vscode-host.ts';
import type { Account, Host, Provider, SharePolicy } from '../../core/types.ts';

const ID = 'claude';

const BINDING: VsCodeBinding = {
  envVar: 'CLAUDE_CONFIG_DIR',
  extensionEnvKey: 'claudeCode.environmentVariables',
  extensionPrefix: 'anthropic.claude-code',
};

/**
 * What travels with you between accounts, and what must not.
 *
 * The split is deliberately default-deny: anything not named in `shared` stays
 * private to its account, so a key we have not seen before is never leaked into
 * another account's directory.
 */
const SHARE_POLICY: SharePolicy = {
  shared: [
    'projects',        // conversation history — powers --resume and recent files
    'history.jsonl',   // prompt history
    'file-history',    // edit checkpoints
    'todos',
    'plans',
    'CLAUDE.md',       // global instructions
    'settings.json',   // hooks, permissions, model prefs
    'commands',        // custom slash commands
    'agents',          // subagent definitions
    'skills',
    'plugins',
  ],
  private: [
    '.credentials.json',        // tokens, on platforms that use a file
    'policy-limits.json',       // per-account rate-limit state
    'remote-settings.json',     // server-pushed, per-account
    'mcp-needs-auth-cache.json',
    'ide',                      // live IDE lockfiles for running sessions
    'sessions',
    'session-env',
    'shell-snapshots',
    'statsig',
    'telemetry',
    'cache',
    'backups',
    '.last-cleanup',
  ],
  merged: [
    {
      // Mixes account identity with portable per-project state in one blob, so
      // it cannot be symlinked. Only these keys cross the account boundary.
      file: '.claude.json',
      sharedKeys: ['projects', 'tipsHistory', 'hasCompletedOnboarding'],
    },
  ],
};

/**
 * The default profile keeps its .claude.json beside the config dir rather than
 * inside it. Named profiles keep it within. Everything that touches that file
 * has to go through here.
 */
function claudeJsonFor(configDir: string): string {
  return path.basename(configDir) === '.claude'
    ? path.join(path.dirname(configDir), '.claude.json')
    : path.join(configDir, '.claude.json');
}

/** Marker entries the CLI creates on first run. */
const MARKERS = ['.claude.json', 'projects', 'settings.json', 'history.jsonl'];

function looksLikeConfigDir(dir: string): boolean {
  if (!isDir(dir)) return false;
  if (exists(claudeJsonFor(dir))) return true;
  return MARKERS.some((m) => exists(path.join(dir, m)));
}

/**
 * Read the account email. This only ever sees identity metadata — the OAuth
 * tokens live in the OS keychain on macOS, or in .credentials.json, neither of
 * which Baton reads or writes at any point.
 */
function readEmail(configDir: string): string | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(claudeJsonFor(configDir), 'utf8'),
    ) as Record<string, unknown>;
    const acct = raw.oauthAccount as Record<string, unknown> | undefined;
    const email = acct?.emailAddress ?? acct?.email;
    return typeof email === 'string' ? email : undefined;
  } catch {
    return undefined;
  }
}

function idFor(dir: string): string {
  const base = path.basename(dir);
  if (base === '.claude') return 'default';
  return base.replace(/^\.claude[-_]?/, '') || base.replace(/^\./, '');
}

function discoverAccounts(home = os.homedir()): Account[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === '.claude' || e.name.startsWith('.claude-'))
    .map((e) => path.join(home, e.name))
    .filter(looksLikeConfigDir)
    .map((configDir) => ({
      id: idFor(configDir),
      label: path.basename(configDir) === '.claude' ? 'Default' : idFor(configDir),
      configDir,
      email: readEmail(configDir),
      isDefault: path.basename(configDir) === '.claude',
      providerId: ID,
    }))
    .sort((a, b) =>
      a.isDefault ? -1 : b.isDefault ? 1 : a.id.localeCompare(b.id),
    );
}

/** Is Claude Code actually on this machine, as a CLI or an editor extension? */
function isInstalled(): { installed: boolean; detail: string } {
  const onPath = (() => {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir && exists(path.join(dir, 'claude'))) return path.join(dir, 'claude');
    }
    return null;
  })();
  if (onPath) return { installed: true, detail: `CLI at ${onPath}` };

  const viaExtension = KNOWN_EDITORS.flatMap((e) =>
    findExtensions(e.extDir, 'anthropic.claude-code').map(() => e.label),
  );
  if (viaExtension.length) {
    return { installed: true, detail: `extension in ${[...new Set(viaExtension)].join(', ')}` };
  }
  return { installed: false, detail: 'not found on PATH or in any editor' };
}

export const claudeProvider: Provider = {
  id: ID,
  label: 'Claude Code',
  envVar: BINDING.envVar,
  processName: 'claude',
  isInstalled,
  sharePolicy: SHARE_POLICY,
  discoverAccounts,
  discoverHosts: () => discoverVsCodeHosts(ID, BINDING),
  resolveFile: (account, relPath) =>
    relPath === '.claude.json'
      ? claudeJsonFor(account.configDir)
      : path.join(account.configDir, relPath),
  bindHost: (host: Host, configDir: string, opts) =>
    bindVsCodeHost(host, configDir, BINDING, opts),
};
