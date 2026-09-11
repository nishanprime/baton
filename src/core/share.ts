import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists, isSymlink } from './paths.ts';
import { backupEntry } from './backups.ts';
import { mergeFile } from './merge.ts';
import type { Account, Provider } from './types.ts';

export interface LinkAction {
  entry: string;
  action:
    | 'already-linked'
    | 'relinked'
    | 'moved-to-store'
    | 'merged-into-store'
    | 'combined-by-content'
    | 'identical'
    | 'overwritten-by-store'
    | 'linked'
    | 'skipped';
  detail?: string;
}

/**
 * Count the files under a path, for the before/after check below.
 *
 * Pooling moves real conversation history, and a file lost in the middle of a
 * recursive merge is silent — the directory still exists, the operation still
 * reports success, and nobody notices until they go looking for a conversation
 * that is not there. Counting is cheap; finding out later is not.
 */
function countFiles(p: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else total++;
    }
  };
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else total = 1;
  } catch {
    return 0;
  }
  return total;
}

export class IntegrityError extends Error {
  // Written out rather than declared as constructor parameter properties:
  // Node's type-stripping runtime rejects those, and tsc does not catch it.
  entry: string;
  expected: number;
  actual: number;
  backup: string | null;

  constructor(entry: string, expected: number, actual: number, backup: string | null) {
    super(
      `Pooling "${entry}" left the shared store with ${actual} files where it had ${expected} ` +
        `before. Nothing further was changed.` +
        (backup ? ` The originals are at ${backup}.` : ''),
    );
    this.name = 'IntegrityError';
    this.entry = entry;
    this.expected = expected;
    this.actual = actual;
    this.backup = backup;
  }
}

export interface LinkOptions {
  dryRun?: boolean;
  /**
   * Entries the store already holds, mapped to the source path that seeded
   * them. Carried across accounts during a dry run so the preview can compare
   * against what the store *would* contain, since nothing is on disk yet.
   */
  storeState?: Map<string, string>;
}

const MERGED_DIR = '_merged';

/** What a file-vs-file collision would do, without doing it. */
function predictFileMerge(src: string, dst: string): LinkAction['action'] {
  if (!exists(dst)) return 'moved-to-store';
  try {
    if (fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8')) return 'identical';
  } catch {
    return 'overwritten-by-store';
  }
  const ext = path.extname(src).toLowerCase();
  return ext === '.json' || ext === '.md' ? 'combined-by-content' : 'overwritten-by-store';
}

function describe(action: LinkAction['action'], dst: string): string {
  switch (action) {
    case 'identical':
      return 'same content as the store copy';
    case 'combined-by-content':
      return 'contents combined; conflicting values keep the store copy';
    case 'overwritten-by-store':
      return 'store copy wins; this one is backed up, not merged';
    default:
      return `-> ${dst}`;
  }
}

/**
 * Fold `src` into `dst` without losing anything.
 *
 * Conversation history is the case that matters: two accounts each hold
 * different project folders under projects/, and a plain overwrite would
 * silently destroy one side. Existing files in `dst` always win; a losing file
 * from `src` is backed up rather than dropped.
 */
function mergeInto(src: string, dst: string, tag: string): void {
  const st = fs.statSync(src);

  if (!st.isDirectory()) {
    if (exists(dst)) {
      // Try a content-aware combine before falling back to "store wins".
      backupEntry(src, tag);
      mergeFile(src, dst);
      fs.rmSync(src, { force: true });
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    }
    return;
  }

  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src)) {
    mergeInto(path.join(src, e), path.join(dst, e), tag);
  }
  // Directory is empty once every child has been folded in.
  try {
    fs.rmdirSync(src);
  } catch {
    /* non-empty because something was backed up in place; harmless */
  }
}

/**
 * Point one account's shared entries at the provider's shared store, so its
 * conversation history is the same history every other account sees.
 */
export function linkAccount(
  provider: Provider,
  account: Account,
  opts: LinkOptions = {},
): LinkAction[] {
  const store = sharedStore(provider.id);
  const actions: LinkAction[] = [];

  if (!opts.dryRun) fs.mkdirSync(store, { recursive: true });

  for (const entry of provider.sharePolicy.shared) {
    const src = path.join(account.configDir, entry);
    const dst = path.join(store, entry);

    if (isSymlink(src)) {
      const current = (() => {
        try {
          return fs.readlinkSync(src);
        } catch {
          return '';
        }
      })();
      if (path.resolve(current) === path.resolve(dst)) {
        actions.push({ entry, action: 'already-linked' });
        continue;
      }
      if (!opts.dryRun) {
        fs.rmSync(src, { force: true });
        fs.mkdirSync(path.dirname(src), { recursive: true });
        fs.symlinkSync(dst, src);
      }
      actions.push({ entry, action: 'relinked', detail: `was -> ${current}` });
      continue;
    }

    const srcExists = exists(src);
    const dstExists = exists(dst) || (opts.storeState?.has(entry) ?? false);
    // During a dry run the store is empty, so compare against whichever file
    // would have seeded it.
    const compareAgainst = exists(dst) ? dst : (opts.storeState?.get(entry) ?? dst);
    const srcIsDir = srcExists && fs.statSync(src).isDirectory();
    // Only entries that actually reach the store count, or a dry run would
    // predict links for entries that exist nowhere.
    if (srcExists && !opts.storeState?.has(entry)) opts.storeState?.set(entry, src);

    if (!srcExists && !dstExists) {
      actions.push({ entry, action: 'skipped', detail: 'not present in either' });
      continue;
    }

    const fileAction =
      srcExists && dstExists && !srcIsDir ? predictFileMerge(src, compareAgainst) : 'moved-to-store';

    if (srcExists) {
      if (opts.dryRun) {
        // A directory folds together entry by entry; a plain file cannot, so the
        // copy already in the store wins and this one is only kept as a backup.
        const action = !dstExists
          ? 'moved-to-store'
          : srcIsDir
            ? 'merged-into-store'
            : predictFileMerge(src, compareAgainst);
        actions.push({ entry, action, detail: describe(action, dst) });
        continue;
      }
      const backup = backupEntry(src, `${account.id}-prelink`);
      // The invariant is one-directional: a conflict legitimately drops a
      // losing duplicate, so the count can stay flat, but folding one account
      // in must never leave the store with FEWER files than it already had.
      const storeBefore = countFiles(dst);
      mergeInto(src, dst, `${account.id}-conflict`);
      const storeAfter = countFiles(dst);
      if (storeAfter < storeBefore) {
        throw new IntegrityError(entry, storeBefore, storeAfter, backup);
      }
      actions.push({
        entry,
        action: !dstExists ? 'moved-to-store' : srcIsDir ? 'merged-into-store' : fileAction,
      });
    }

    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(src), { recursive: true });
      if (!exists(dst)) {
        // Store side is a directory-shaped entry that never existed; create it
        // so the symlink resolves instead of dangling.
        fs.mkdirSync(dst, { recursive: true });
      }
      fs.symlinkSync(dst, src);
    }
    if (!srcExists) actions.push({ entry, action: 'linked' });
  }

  return actions;
}

/**
 * Reverse `linkAccount`: replace every symlink with a real copy, leaving the
 * account standalone again. The escape hatch if Baton is ever uninstalled.
 */
export function unlinkAccount(
  provider: Provider,
  account: Account,
  opts: { dryRun?: boolean } = {},
): LinkAction[] {
  const actions: LinkAction[] = [];
  for (const entry of provider.sharePolicy.shared) {
    const src = path.join(account.configDir, entry);
    if (!isSymlink(src)) continue;
    const target = fs.readlinkSync(src);
    if (!opts.dryRun) {
      fs.rmSync(src, { force: true });
      if (exists(target)) fs.cpSync(target, src, { recursive: true });
    }
    actions.push({ entry, action: 'skipped', detail: `materialised from ${target}` });
  }
  return actions;
}

const mergedStorePath = (providerId: string, file: string) =>
  path.join(sharedStore(providerId), MERGED_DIR, file);

/** Honour a provider's custom placement, falling back to a plain join. */
const resolve = (provider: Provider, account: Account, rel: string) =>
  provider.resolveFile?.(account, rel) ?? path.join(account.configDir, rel);

function readJsonFile(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Lift the portable keys out of an account's mixed identity/state files into the
 * shared store. Run this on the account you are switching *away* from, so its
 * newest project state is carried forward.
 */
export function captureMerged(provider: Provider, account: Account): string[] {
  const captured: string[] = [];
  for (const mf of provider.sharePolicy.merged) {
    const accountFile = resolve(provider, account, mf.file);
    if (!exists(accountFile)) continue;

    const from = readJsonFile(accountFile);
    const storeFile = mergedStorePath(provider.id, mf.file);
    const store = readJsonFile(storeFile);

    for (const key of mf.sharedKeys) {
      if (key in from) store[key] = from[key];
    }
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf8');
    captured.push(mf.file);
  }
  return captured;
}

/**
 * Push the shared keys into the account you are switching *to*, leaving every
 * other key — identity, subscription, anything unrecognised — untouched.
 */
export function applyMerged(
  provider: Provider,
  account: Account,
  opts: { dryRun?: boolean } = {},
): string[] {
  const applied: string[] = [];
  for (const mf of provider.sharePolicy.merged) {
    const storeFile = mergedStorePath(provider.id, mf.file);
    if (!exists(storeFile)) continue;

    const store = readJsonFile(storeFile);
    const accountFile = resolve(provider, account, mf.file);
    const target = readJsonFile(accountFile);

    let changed = false;
    for (const key of mf.sharedKeys) {
      if (key in store) {
        target[key] = store[key];
        changed = true;
      }
    }
    if (!changed) continue;

    if (!opts.dryRun) {
      if (exists(accountFile)) backupEntry(accountFile, `${account.id}-premerge`);
      fs.mkdirSync(path.dirname(accountFile), { recursive: true });
      fs.writeFileSync(accountFile, JSON.stringify(target, null, 2), 'utf8');
    }
    applied.push(mf.file);
  }
  return applied;
}
