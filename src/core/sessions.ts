import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Account, Provider } from './types.ts';

export interface LiveSession {
  pid: number;
  providerId: string;
  /** Config dir this session was launched with, read from its environment. */
  configDir: string | null;
  accountId: string | null;
  /** How it was launched, e.g. claude-vscode. */
  entrypoint: string | null;
  /** Editor the binary was launched from, inferred from its path. */
  editorHint: string | null;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Read one process's environment. POSIX only; ps exposes it for your own processes. */
function envOf(pid: number): Record<string, string> {
  const raw = run('ps', ['eww', '-p', String(pid)]);
  const env: Record<string, string> = {};
  for (const token of raw.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      if (/^[A-Z_][A-Z0-9_]*$/.test(key)) env[key] = token.slice(eq + 1);
    }
  }
  return env;
}

/** Which editor an extension-hosted binary belongs to, from its install path. */
function editorFromPath(command: string): string | null {
  const m = /\/\.([a-z-]+)\/extensions\//.exec(command);
  if (m) return m[1]!.replace(/-ide$/, '');
  if (command.includes('/Applications/')) {
    return /\/Applications\/([^/]+)\.app/.exec(command)?.[1] ?? null;
  }
  return null;
}

/**
 * Sessions of a provider's CLI that are running right now, with the account
 * each one is using.
 *
 * This matters when switching: a running process read its credentials at
 * startup and keeps them in memory, so changing the binding does not affect a
 * live session until that window is reloaded.
 */
export function findLiveSessions(providers: Provider[], accounts: Account[]): LiveSession[] {
  if (process.platform === 'win32') return []; // ps-based; no Windows support yet

  const listing = run('ps', ['-Ao', 'pid=,command=']);
  const sessions: LiveSession[] = [];

  for (const line of listing.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2]!;

    for (const provider of providers) {
      // The CLI binary itself, not an editor window or this process.
      const bin = provider.processName ?? provider.id;
      const isMatch =
        new RegExp(`/${bin}(\\s|$)`).test(command) && !command.includes('baton');
      if (!isMatch) continue;

      const env = envOf(pid);
      const configDir = env[provider.envVar] ?? null;
      const resolved = configDir ? path.resolve(configDir) : null;

      sessions.push({
        pid,
        providerId: provider.id,
        configDir: resolved,
        accountId:
          accounts.find((a) => path.resolve(a.configDir) === resolved)?.id ??
          (resolved ? null : accounts.find((a) => a.isDefault)?.id ?? null),
        entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
        editorHint: editorFromPath(command),
      });
      break;
    }
  }
  return sessions;
}
