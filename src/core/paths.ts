import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Config root for VS Code-family editors. Every fork keeps its per-user
 * settings at <root>/<EditorName>/User/settings.json.
 */
export function editorConfigRoot(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'win32':
      return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    default:
      return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  }
}

/**
 * Editors known to ship provider extensions that honour a config-dir env var.
 *
 * `dirNames` locate User/settings.json under the config root; `extDir` is the
 * separate home-relative folder the editor installs extensions into, which is
 * how we tell whether a provider's extension is actually present.
 */
export const KNOWN_EDITORS = [
  { id: 'vscode', label: 'VS Code', dirNames: ['Code'], extDir: '.vscode/extensions' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', dirNames: ['Code - Insiders'], extDir: '.vscode-insiders/extensions' },
  { id: 'cursor', label: 'Cursor', dirNames: ['Cursor'], extDir: '.cursor/extensions' },
  { id: 'antigravity', label: 'Antigravity', dirNames: ['Antigravity IDE', 'Antigravity'], extDir: '.antigravity-ide/extensions' },
  { id: 'windsurf', label: 'Windsurf', dirNames: ['Windsurf'], extDir: '.windsurf/extensions' },
  { id: 'vscodium', label: 'VSCodium', dirNames: ['VSCodium'], extDir: '.vscode-oss/extensions' },
  { id: 'trae', label: 'Trae', dirNames: ['Trae'], extDir: '.trae/extensions' },
] as const;

/** Extension folders matching a prefix, e.g. "anthropic.claude-code". */
export function findExtensions(extDir: string, prefix: string): string[] {
  const full = path.join(os.homedir(), extDir);
  try {
    return fs.readdirSync(full).filter((d) => d.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Baton's own state: registry, shared history store, and safety backups. */
export function appHome(): string {
  return process.env.BATON_HOME ?? path.join(os.homedir(), '.baton');
}

export const registryPath = () => path.join(appHome(), 'registry.json');
export const sharedStore = (providerId: string) => path.join(appHome(), 'shared', providerId);
export const backupsPath = () => path.join(appHome(), 'backups');

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** lstat-based, so a symlink counts as existing even when its target is gone. */
export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Timestamped copy of a file into the backups dir, before we modify it. */
export function backupFile(file: string, tag: string): string | undefined {
  if (!exists(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupsPath(), stamp);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${tag}-${path.basename(file)}`);
  fs.copyFileSync(file, dest);
  return dest;
}
