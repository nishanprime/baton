import os from 'node:os';
import type { Settings } from './settings.ts';

/**
 * Presentation rules for anything that leaves the machine as a screenshot.
 *
 * Masking is deterministic rather than random: two runs produce the same
 * pseudonym for the same project, so a redacted screenshot is still readable
 * as "these two rows are different projects".
 */

export function maskEmail(email: string | null | undefined): string {
  if (!email) return 'not logged in';
  const [user = '', domain = ''] = email.split('@');
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(3, user.length - 1))}@${'•'.repeat(4)}${tld}`;
}

/** Stable "Project A", "Project B"… assigned in sorted order. */
export function makeProjectMasker(projects: string[]): (name: string) => string {
  const sorted = [...new Set(projects)].sort();
  const map = new Map<string, string>();
  sorted.forEach((p, i) => {
    const letter =
      i < 26
        ? String.fromCharCode(65 + i)
        : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`;
    map.set(p, `Project ${letter}`);
  });
  return (name: string) => map.get(name) ?? 'Project ?';
}

/** The name to show for an account: its alias if one is set, else its id. */
export function accountLabel(id: string, settings: Settings): string {
  return settings.display.aliases[id] ?? id;
}

export function accountEmail(email: string | null | undefined, settings: Settings): string {
  return settings.display.hideEmails ? maskEmail(email) : (email ?? 'not logged in');
}

/**
 * Shorten the home directory to ~ always, and redact the rest under privacy.
 *
 * Paths leak more than they look like they do: a config dir carries the account
 * name, and a prompt quoting an absolute path carries the whole folder tree.
 * Both routinely end up in screenshots.
 */
export function maskPath(p: string, settings: Settings, home = os.homedir()): string {
  const short = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (!settings.display.hideProjects) return short;
  return short.replace(/(~?\/)(?:[^/\s]+\/)+([^/\s]*)/g, '$1…/$2');
}

/** Redact absolute paths appearing inside free text, such as a prompt title. */
export function maskPathsInText(text: string, settings: Settings, home = os.homedir()): string {
  let out = text.split(home).join('~');
  if (settings.display.hideProjects) {
    out = out.replace(/(~?\/)(?:[^/\s]+\/){1,}([^/\s]*)/g, '$1…/$2');
  }
  return out;
}
