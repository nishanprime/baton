import fs from 'node:fs';
import path from 'node:path';
import { appHome } from './paths.ts';

/**
 * User preferences, shared by the CLI and the GUI so both read and write the
 * same file rather than each keeping its own idea of the config.
 */
export interface Settings {
  autoSwitch: {
    /** Watch for a spent account and act when one is found. */
    enabled: boolean;
    /** 'notify' only tells you; 'switch' rotates editors on its own. */
    mode: 'notify' | 'switch';
    /** Account ids to try in order. Empty means every account, discovery order. */
    rotation: string[];
    /** How often to check, in seconds. */
    pollSeconds: number;
  };
  /** Account each editor should start on, by host id. */
  defaultAccountByHost: Record<string, string>;
  /** How things are shown, for screen sharing and screenshots. */
  display: {
    /** Account id → display name. Cosmetic only; never changes a config path. */
    aliases: Record<string, string>;
    hideEmails: boolean;
    hideProjects: boolean;
  };
  /**
   * Backup retention. Snapshots are taken before anything destructive, so
   * without a budget they grow past the history they exist to protect.
   */
  backups: {
    /** Newest snapshots always kept, whatever the size or age budget says. */
    keepCount: number;
    /** Total budget in megabytes; oldest go first once it is exceeded. */
    maxTotalMb: number;
    /** Snapshots older than this are dropped, subject to keepCount. */
    maxAgeDays: number;
  };
  /** Print the "reload the window" reminder after a switch. */
  showReloadHint: boolean;
}

export const DEFAULTS: Settings = {
  autoSwitch: { enabled: false, mode: 'notify', rotation: [], pollSeconds: 60 },
  defaultAccountByHost: {},
  display: { aliases: {}, hideEmails: false, hideProjects: false },
  backups: { keepCount: 10, maxTotalMb: 500, maxAgeDays: 14 },
  showReloadHint: true,
};

/** Dotted paths that may be set from the CLI, with how to parse each one. */
export const SCHEMA: Record<string, { type: 'boolean' | 'number' | 'string' | 'list'; values?: string[]; help: string }> = {
  'autoSwitch.enabled': { type: 'boolean', help: 'watch for a spent account and act' },
  'autoSwitch.mode': { type: 'string', values: ['notify', 'switch'], help: 'notify only, or switch automatically' },
  'autoSwitch.rotation': { type: 'list', help: 'account ids to try in order (comma separated)' },
  'autoSwitch.pollSeconds': { type: 'number', help: 'how often to check, in seconds' },
  'showReloadHint': { type: 'boolean', help: 'show the reload reminder after switching' },
  'display.hideEmails': { type: 'boolean', help: 'mask account emails in output' },
  'display.hideProjects': { type: 'boolean', help: 'replace project names with Project A, B, …' },
  'backups.keepCount': { type: 'number', help: 'newest snapshots always kept' },
  'backups.maxTotalMb': { type: 'number', help: 'total backup budget in MB' },
  'backups.maxAgeDays': { type: 'number', help: 'drop snapshots older than this' },
};

/** Set or clear a cosmetic display name for an account. */
export function setAlias(accountId: string, alias: string | null): Settings {
  const s = loadSettings();
  if (alias && alias.trim()) s.display.aliases[accountId] = alias.trim();
  else delete s.display.aliases[accountId];
  saveSettings(s);
  return s;
}

const settingsFile = () => path.join(appHome(), 'settings.json');

function deepDefault<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)) {
    const out = { ...(fallback as object) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepDefault(v, (fallback as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value as T;
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>;
    return deepDefault(raw, DEFAULTS);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings): void {
  const f = settingsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
}

function getAt(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
    obj,
  );
}

function setAt(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  const last = keys.pop()!;
  let cur = obj;
  for (const k of keys) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[last] = value;
}

/** Parse a string from the command line into the type the schema expects. */
export function coerce(key: string, raw: string): unknown {
  const spec = SCHEMA[key];
  if (!spec) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(SCHEMA).join(', ')}`);

  switch (spec.type) {
    case 'boolean': {
      if (/^(true|on|yes|1)$/i.test(raw)) return true;
      if (/^(false|off|no|0)$/i.test(raw)) return false;
      throw new Error(`${key} expects true or false, got "${raw}"`);
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${key} expects a number, got "${raw}"`);
      return n;
    }
    case 'list':
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    default: {
      if (spec.values && !spec.values.includes(raw)) {
        throw new Error(`${key} expects one of ${spec.values.join(', ')}, got "${raw}"`);
      }
      return raw;
    }
  }
}

export function getSetting(key: string): unknown {
  return getAt(loadSettings() as unknown as Record<string, unknown>, key);
}

export function setSetting(key: string, raw: string): Settings {
  const value = coerce(key, raw);
  const s = loadSettings() as unknown as Record<string, unknown>;
  setAt(s, key, value);
  const next = s as unknown as Settings;
  saveSettings(next);
  return next;
}

export function settingsPath(): string {
  return settingsFile();
}
