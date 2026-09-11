import path from 'node:path';
import { loadSettings, saveSettings } from './settings.ts';

/**
 * Per-directory account pins.
 *
 * An editor binds an account for the whole application, which is the wrong
 * granularity when one account belongs to client work and another to personal
 * projects. A pin says "this directory tree belongs to that account", and the
 * terminal flow reads it so `baton shell` in a pinned tree needs no argument.
 *
 * Pins are advisory. Nothing enforces them, because enforcing would mean
 * intercepting every launch — they resolve a default, and that is all.
 */

export interface Pin {
  /** Absolute, normalised directory the pin applies to, including its subtree. */
  dir: string;
  accountId: string;
}

function normalise(dir: string): string {
  return path.resolve(dir).replace(/[/\\]+$/, '') || path.sep;
}

export function listPins(): Pin[] {
  const pins = loadSettings().pins ?? {};
  return Object.entries(pins)
    .map(([dir, accountId]) => ({ dir, accountId }))
    // Longest path first, so the most specific pin wins a lookup.
    .sort((a, b) => b.dir.length - a.dir.length);
}

export function setPin(dir: string, accountId: string): Pin {
  const settings = loadSettings();
  settings.pins = { ...(settings.pins ?? {}), [normalise(dir)]: accountId };
  saveSettings(settings);
  return { dir: normalise(dir), accountId };
}

export function removePin(dir: string): boolean {
  const settings = loadSettings();
  const key = normalise(dir);
  if (!settings.pins || !(key in settings.pins)) return false;
  delete settings.pins[key];
  saveSettings(settings);
  return true;
}

/**
 * The account pinned for a directory, walking up to the nearest ancestor pin.
 *
 * A pin on /work covers /work/repo/src without needing three entries, and a
 * more specific pin deeper in the tree overrides it.
 */
export function pinFor(dir: string): Pin | null {
  const target = normalise(dir);
  for (const pin of listPins()) {
    if (target === pin.dir || target.startsWith(`${pin.dir}${path.sep}`)) return pin;
  }
  return null;
}
