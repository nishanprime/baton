import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sharedStore, backupsPath, exists } from './paths.ts';
import { findLiveSessions, type LiveSession } from './sessions.ts';
import { findLimitEvents, type LimitEvent } from './limits.ts';
import { loadSettings } from './settings.ts';
import type { Account, Host, Provider } from './types.ts';

/**
 * What happens to an account after it is created: is it usable, is it in use,
 * can it be logged in again, can it be thrown away.
 *
 * Two constraints shape everything here. History is pooled — a conversation
 * does not record which account created it — so removing an account must never
 * be allowed to remove conversations. And credentials live in the keychain or
 * in a file the account carries, so nothing below reads, writes, or copies one.
 */

// ---------------------------------------------------------------- state

export type AccountState =
  /** A directory exists but nothing has ever logged into it. */
  | 'draft'
  /** Logged in and bound to at least one editor or live session. */
  | 'active'
  /** Logged in, bound to nothing. */
  | 'idle'
  /** Logged in and out of quota for now. */
  | 'spent';

export interface AccountStatus {
  accountId: string;
  configDir: string;
  state: AccountState;
  /** One line saying why it is in that state. */
  reason: string;
  /** What the user should do about it, phrased as an instruction. */
  nextAction: string;
  /**
   * Ready-to-paste command that logs this account in. Present for a draft,
   * which is the state where the user is stuck without it; `reauthCommand`
   * returns the same string for an account in any state.
   */
  loginCommand: string | null;
  email: string | null;
  liveSessions: LiveSession[];
  boundHosts: Host[];
  /** Newest limit event attributed to this account, when it is spent. */
  limit: LimitEvent | null;
}

export interface ClassifyOptions {
  /** Defaults to the provider's own discovery. Inject to classify a set at once. */
  hosts?: Host[];
  /** Candidate exhaustion events. Defaults to a fresh scan of the pooled history. */
  limits?: LimitEvent[];
  /** How far back an exhaustion event still counts. A session limit runs ~5h. */
  spentWindowMinutes?: number;
  now?: number;
}

const DEFAULT_SPENT_WINDOW_MINUTES = 300;

const resolveEq = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** Sessions belonging to this account, including one that inherited the default dir. */
function sessionsFor(account: Account, sessions: LiveSession[]): LiveSession[] {
  return sessions.filter((s) =>
    s.configDir ? resolveEq(s.configDir, account.configDir) : s.accountId === account.id,
  );
}

/**
 * Editors pointing here. A host with no binding at all still resolves to the
 * provider's implicit directory, so the default account counts as bound to it.
 */
function hostsFor(account: Account, hosts: Host[]): Host[] {
  return hosts.filter((h) =>
    h.configDir ? resolveEq(h.configDir, account.configDir) : account.isDefault,
  );
}

/**
 * Whether anything has logged in here.
 *
 * The account email is the primary signal; a credentials file is the fallback
 * for providers that keep one on disk. Deliberately not `userID` or
 * `machineID` — the CLI writes both on its very first start, so a directory
 * that was created and then abandoned has them and is still a draft.
 */
export function hasIdentity(provider: Provider, account: Account): boolean {
  if (account.email) return true;
  return provider.sharePolicy.private
    .filter((rel) => /credential/i.test(rel))
    .some((rel) => exists(resolveEntry(provider, account, rel)));
}

const resolveEntry = (provider: Provider, account: Account, rel: string): string =>
  provider.resolveFile?.(account, rel) ?? path.join(account.configDir, rel);

/**
 * Which state an account is in, and what to do about it.
 *
 * Attribution caveat for 'spent': the pooled transcript records the project and
 * the error, never the account, so an exhaustion event is credited to whichever
 * account is bound now. An account you have already switched away from reads as
 * idle rather than spent. Pass `opts.limits` pre-filtered if you have better
 * information than the binding.
 */
export function classifyAccount(
  provider: Provider,
  account: Account,
  liveSessions: LiveSession[] = findLiveSessions([provider], [account]),
  opts: ClassifyOptions = {},
): AccountStatus {
  const now = opts.now ?? Date.now();
  const windowMinutes = opts.spentWindowMinutes ?? DEFAULT_SPENT_WINDOW_MINUTES;
  const hosts = opts.hosts ?? provider.discoverHosts();

  const mine = sessionsFor(account, liveSessions);
  const bound = hostsFor(account, hosts);
  const isBound = mine.length > 0 || bound.length > 0;

  const base = {
    accountId: account.id,
    configDir: account.configDir,
    email: account.email ?? null,
    liveSessions: mine,
    boundHosts: bound,
  };

  if (!hasIdentity(provider, account)) {
    const { command } = reauthCommand(provider, account);
    return {
      ...base,
      state: 'draft',
      limit: null,
      loginCommand: command,
      reason: mine.length
        ? 'the directory exists and a session is open, but nothing has logged in yet'
        : 'the directory exists but nothing has ever logged in',
      nextAction: `Log in with: ${command}  — then run /login inside that session.`,
    };
  }

  const limit = isBound ? newestLimit(provider, opts.limits, now, windowMinutes) : null;

  if (limit) {
    return {
      ...base,
      state: 'spent',
      limit,
      loginCommand: null,
      reason: limit.resets
        ? `hit its limit ${describeAge(limit.at, now)}; resets ${limit.resets}`
        : `hit its limit ${describeAge(limit.at, now)}`,
      nextAction: limit.resets
        ? `Switch to another account until it resets ${limit.resets}.`
        : 'Switch to another account until the limit clears.',
    };
  }

  if (isBound) {
    const where = [
      ...bound.map((h) => h.label),
      ...mine.map((s) => `pid ${s.pid}${s.editorHint ? ` (${s.editorHint})` : ''}`),
    ];
    return {
      ...base,
      state: 'active',
      limit: null,
      loginCommand: null,
      reason: `in use by ${where.join(', ')}`,
      nextAction: 'Nothing to do — this is the account in use.',
    };
  }

  return {
    ...base,
    state: 'idle',
    limit: null,
    loginCommand: null,
    reason: 'logged in, but no editor or session is pointing at it',
    nextAction: `Point an editor at it with \`baton use ${account.id}\`, or remove it.`,
  };
}

/** Classify a whole set, scanning sessions, hosts and limits once rather than per account. */
export function classifyAccounts(
  provider: Provider,
  accounts: Account[],
  opts: ClassifyOptions & { liveSessions?: LiveSession[] } = {},
): AccountStatus[] {
  const sessions = opts.liveSessions ?? findLiveSessions([provider], accounts);
  const hosts = opts.hosts ?? provider.discoverHosts();
  const windowMinutes = opts.spentWindowMinutes ?? DEFAULT_SPENT_WINDOW_MINUTES;
  const limits = opts.limits ?? findLimitEvents([provider], { sinceMinutes: windowMinutes });
  return accounts.map((a) => classifyAccount(provider, a, sessions, { ...opts, hosts, limits }));
}

function newestLimit(
  provider: Provider,
  supplied: LimitEvent[] | undefined,
  now: number,
  windowMinutes: number,
): LimitEvent | null {
  const events = supplied ?? findLimitEvents([provider], { sinceMinutes: windowMinutes });
  const cutoff = now - windowMinutes * 60_000;
  const fresh = events
    .filter((e) => e.providerId === provider.id)
    .filter((e) => {
      const t = Date.parse(e.at);
      return Number.isNaN(t) ? false : t >= cutoff;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return fresh[0] ?? null;
}

function describeAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'recently';
  const minutes = Math.max(0, Math.round((now - t) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// ---------------------------------------------------------------- re-auth

export interface LoginCommand {
  /** The full command line, quoted so a path with a space in it survives. */
  command: string;
  explanation: string;
}

/**
 * Single-quote for a POSIX shell. Double quotes are not enough: the config dir
 * is user-named, and one with a `$` or a backtick in it would be expanded.
 */
function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** PowerShell single-quote; the only escape inside is a doubled quote. */
function psQuote(s: string): string {
  return `'${s.split("'").join("''")}'`;
}

/** The command that logs a given config directory in, without an Account in hand. */
export function loginCommandForDir(provider: Provider, configDir: string): string {
  const bin = provider.processName ?? provider.id;
  if (process.platform === 'win32') {
    return `$env:${provider.envVar}=${psQuote(configDir)}; ${bin}`;
  }
  return `${provider.envVar}=${shQuote(configDir)} ${bin}`;
}

/**
 * How to log this account in, or log it in again as someone else.
 *
 * Baton never touches the credential itself: this hands back the command and
 * the provider's own CLI does the authentication into its own store.
 */
export function reauthCommand(provider: Provider, account: Account): LoginCommand {
  const command = loginCommandForDir(provider, account.configDir);
  const shell = process.platform === 'win32' ? 'PowerShell' : 'a terminal';
  return {
    command,
    explanation:
      `Run this in ${shell}, then \`/login\` inside the session it opens. ` +
      `It starts ${provider.label} against ${account.configDir}, so the login lands in ` +
      `that directory and nowhere else. Baton never sees the credential.`,
  };
}

// ---------------------------------------------------------------- refusals

export type RefusalCode =
  | 'not-found'
  | 'shared-store'
  | 'unsafe-path'
  | 'live-sessions'
  | 'default-account'
  | 'target-exists'
  | 'invalid-name'
  | 'relative-link';

export interface Refusal {
  code: RefusalCode;
  message: string;
  /** Whether `force` may override it. A store or path refusal never can. */
  overridable: boolean;
}

export class LifecycleError extends Error {
  code: RefusalCode;
  refusals: Refusal[];

  constructor(refusals: Refusal[]) {
    super(refusals.map((r) => r.message).join(' '));
    this.name = 'LifecycleError';
    this.code = refusals[0]?.code ?? 'not-found';
    this.refusals = refusals;
  }
}

// ---------------------------------------------------------------- removal

export type HistoryDisposition = 'keep' | 'delete';

export interface RemoveOptions {
  dryRun?: boolean;
  /** Proceed despite live sessions or the account being the provider default. */
  force?: boolean;
  /** Default 'keep'. 'delete' still never reaches the shared store. */
  history?: HistoryDisposition;
  liveSessions?: LiveSession[];
  hosts?: Host[];
  /** Snapshot before removing. On by default — the snapshot is the only undo. */
  backup?: boolean;
}

export interface RemovedEntry {
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  bytes: number;
}

export interface PreservedEntry {
  path: string;
  reason: string;
  /** Where a copy was put, when the original had to go. */
  copiedTo?: string;
}

export interface RemoveResult {
  accountId: string;
  configDir: string;
  dryRun: boolean;
  history: HistoryDisposition;
  removed: RemovedEntry[];
  preserved: PreservedEntry[];
  /** Shared entries detached from the store first; the store keeps its copy. */
  unlinkedShared: string[];
  /** Reported, never touched. */
  sharedStore: string;
  bytesFreed: number;
  backupPath: string | null;
  /** Editors left pointing at a directory that is gone. The caller re-points them. */
  rebind: Host[];
  /** False when something had to be left behind, so the directory still exists. */
  directoryRemoved: boolean;
  warnings: string[];
}

/**
 * The set of paths a removal is allowed to touch.
 *
 * Everything that deletes goes through `scope.remove`, and a scope can only be
 * built by `removalScope`, which refuses outright if the shared store is inside
 * the account directory or vice versa. The store path is therefore not
 * reachable from here by any argument the caller can pass.
 */
interface RemovalScope {
  configDir: string;
  store: string;
  remove(target: string): void;
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** realpath where possible, so /tmp vs /private/tmp cannot defeat a containment check. */
function realish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function removalScope(provider: Provider, account: Account): RemovalScope {
  // The account dir is resolved without realpath: its own entries are symlinks
  // into the store, and resolving them away would make every child look foreign.
  const configDir = path.resolve(account.configDir);
  const store = realish(sharedStore(provider.id));

  const refusals = pathRefusals(configDir, store);
  if (refusals.length) throw new LifecycleError(refusals);

  return {
    configDir,
    store,
    remove(target: string): void {
      const t = path.resolve(target);
      if (t !== configDir && !isInside(t, configDir)) {
        throw new LifecycleError([
          { code: 'unsafe-path', message: `Refusing to remove ${t}: outside ${configDir}.`, overridable: false },
        ]);
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(t);
      } catch {
        return;
      }
      // A symlink is unlinked explicitly rather than handed to a recursive
      // remove: unlinking drops the link and never the thing it points at, so
      // this branch cannot reach store content even when it links straight to it.
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(t);
        return;
      }
      // Compared after resolving, so a store reached by a different spelling of
      // the same path — /var vs /private/var, a symlinked home — is still caught.
      const real = realish(t);
      if (real === store || isInside(real, store) || isInside(store, real)) {
        throw new LifecycleError([
          { code: 'shared-store', message: `Refusing to remove ${t}: that is the shared history store.`, overridable: false },
        ]);
      }
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 2 });
    },
  };
}

function pathRefusals(configDir: string, store: string): Refusal[] {
  const out: Refusal[] = [];
  const real = realish(configDir);
  if (real === store || isInside(real, store)) {
    out.push({
      code: 'shared-store',
      message: `${configDir} is the shared history store. Removing it would delete every account's conversations.`,
      overridable: false,
    });
  }
  if (isInside(store, real)) {
    out.push({
      code: 'shared-store',
      message: `The shared history store lives inside ${configDir}. Move BATON_HOME out of the account directory before removing it.`,
      overridable: false,
    });
  }
  const home = realish(os.homedir());
  if (real === home || real === path.parse(real).root || !isInside(real, path.dirname(real))) {
    out.push({
      code: 'unsafe-path',
      message: `${configDir} is not a safe directory to remove.`,
      overridable: false,
    });
  }
  return out;
}

/** Everything that would stop a removal, so a caller can disable a button instead of catching. */
export function canRemoveAccount(
  provider: Provider,
  account: Account,
  opts: RemoveOptions = {},
): { ok: boolean; refusals: Refusal[] } {
  const refusals: Refusal[] = [];
  if (!exists(account.configDir)) {
    refusals.push({
      code: 'not-found',
      message: `${account.configDir} does not exist.`,
      overridable: false,
    });
    return { ok: false, refusals };
  }

  refusals.push(...pathRefusals(path.resolve(account.configDir), realish(sharedStore(provider.id))));

  const sessions = sessionsFor(
    account,
    opts.liveSessions ?? findLiveSessions([provider], [account]),
  );
  if (sessions.length) {
    const who = sessions
      .map((s) => `pid ${s.pid}${s.editorHint ? ` in ${s.editorHint}` : ''}${s.entrypoint ? ` (${s.entrypoint})` : ''}`)
      .join(', ');
    refusals.push({
      code: 'live-sessions',
      message: `${account.id} has ${sessions.length} live session(s): ${who}. Quit them first, or pass force.`,
      overridable: true,
    });
  }

  if (account.isDefault) {
    refusals.push({
      code: 'default-account',
      message: `${account.id} is the directory ${provider.label} falls back to when ${provider.envVar} is unset. Removing it changes what an unbound editor does.`,
      overridable: true,
    });
  }

  const blocking = refusals.filter((r) => !r.overridable || !opts.force);
  return { ok: blocking.length === 0, refusals };
}

/**
 * Remove an account directory.
 *
 * The shared store is never a candidate — see `removalScope`. Under the default
 * `history: 'keep'` the account's shared entries are detached first, so the
 * store is not even reachable through a symlink while the directory is torn
 * down, and any history that was never pooled is copied into the snapshot
 * before it goes, or left in place if it could not be.
 */
export function removeAccount(
  provider: Provider,
  account: Account,
  opts: RemoveOptions = {},
): RemoveResult {
  const dryRun = opts.dryRun ?? false;
  const history = opts.history ?? 'keep';
  const wantBackup = opts.backup ?? true;

  const check = canRemoveAccount(provider, account, opts);
  if (!check.ok) throw new LifecycleError(check.refusals.filter((r) => !r.overridable || !opts.force));

  const scope = removalScope(provider, account);
  const hosts = opts.hosts ?? provider.discoverHosts();
  const rebind = hostsFor(account, hosts);

  const removed: RemovedEntry[] = [];
  const preserved: PreservedEntry[] = [];
  const unlinkedShared: string[] = [];
  const warnings: string[] = [];

  for (const r of check.refusals) {
    if (r.overridable && opts.force) warnings.push(`forced past: ${r.message}`);
  }
  if (rebind.some((h) => !h.configDir)) {
    warnings.push(
      `Some editors have no explicit ${provider.envVar} and fall back to this directory. Bind them to another account.`,
    );
  }

  // A merged file can live outside the account dir — Claude keeps the default
  // profile's .claude.json beside it, not in it. Out of scope by construction.
  for (const mf of provider.sharePolicy.merged) {
    const f = resolveEntry(provider, account, mf.file);
    if (exists(f) && !isInside(path.resolve(f), scope.configDir)) {
      preserved.push({ path: f, reason: 'lives outside the account directory; left alone' });
    }
  }

  const entries = readEntries(scope.configDir);
  const shared = new Set(provider.sharePolicy.shared);

  const backupPath =
    !dryRun && wantBackup ? snapshot(scope.configDir, account.id) : null;

  for (const entry of entries) {
    const full = path.join(scope.configDir, entry.name);
    const linkTarget = entry.kind === 'symlink' ? readLink(full) : null;

    if (entry.kind === 'symlink') {
      // Removing a link never removes what it points at, so this is safe for
      // both dispositions; it is done first so nothing walks the store.
      const intoStore = linkTarget ? isInside(realish(linkTarget), scope.store) || realish(linkTarget) === scope.store : false;
      if (!dryRun) scope.remove(full);
      removed.push({ path: full, kind: 'symlink', bytes: 0 });
      if (intoStore) unlinkedShared.push(entry.name);
      else if (linkTarget && !isInside(path.resolve(linkTarget), scope.configDir)) {
        preserved.push({ path: linkTarget, reason: 'link removed; its target is untouched' });
      }
      continue;
    }

    const bytes = pathSize(full);

    // A shared-policy entry that is a real directory was never pooled, so this
    // copy is the only one. It is the only content whose removal could lose a
    // conversation, so it goes only once it has been copied somewhere.
    if (shared.has(entry.name) && history === 'keep') {
      if (backupPath) {
        preserved.push({
          path: full,
          reason: 'never pooled, so this was the only copy; copied out before removal',
          copiedTo: path.join(backupPath, entry.name),
        });
        if (!dryRun) scope.remove(full);
        removed.push({ path: full, kind: entry.kind, bytes });
      } else if (dryRun) {
        preserved.push({
          path: full,
          reason: 'never pooled, so this is the only copy; would be copied into the snapshot first',
          copiedTo: path.join(backupsPath(), '<snapshot>', entry.name),
        });
        removed.push({ path: full, kind: entry.kind, bytes });
      } else {
        preserved.push({
          path: full,
          reason: 'never pooled and no snapshot was taken; left in place rather than lost',
        });
        warnings.push(
          `${entry.name} kept at ${full}. Run \`baton link ${account.id}\` to pool it, then remove again.`,
        );
      }
      continue;
    }

    if (!dryRun) scope.remove(full);
    removed.push({ path: full, kind: entry.kind, bytes });
  }

  const leftBehind = preserved.some((p) => isInside(path.resolve(p.path), scope.configDir) && !p.copiedTo);
  let directoryRemoved = false;
  if (!leftBehind) {
    if (!dryRun) scope.remove(scope.configDir);
    directoryRemoved = true;
  }

  return {
    accountId: account.id,
    configDir: account.configDir,
    dryRun,
    history,
    removed,
    preserved,
    unlinkedShared,
    sharedStore: sharedStore(provider.id),
    bytesFreed: removed.reduce((n, r) => n + r.bytes, 0),
    backupPath,
    rebind,
    directoryRemoved,
    warnings,
  };
}

interface Entry {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
}

function readEntries(dir: string): Entry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents.map((d) => ({
    name: d.name,
    kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file',
  }));
}

function readLink(p: string): string | null {
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    return null;
  }
}

/** Bytes on disk, never following a symlink — a linked store must not be counted. */
function pathSize(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readEntries(p)) total += pathSize(path.join(p, entry.name));
  return total;
}

/**
 * Copy the account directory into the backups tree before anything is removed.
 *
 * Symlinks are copied verbatim as symlinks: dereferencing them would pull the
 * entire shared history into the snapshot, which is both enormous and exactly
 * the coupling this module exists to avoid.
 */
function snapshot(configDir: string, accountId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = accountId.replace(/[^\w.-]+/g, '_') || 'account';
  const dest = path.join(backupsPath(), stamp, `${safeId}-removed`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(configDir, dest, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: true,
  });
  return dest;
}

// ---------------------------------------------------------------- rename

export interface Consequence {
  kind: 'host' | 'setting' | 'session' | 'link' | 'note';
  detail: string;
  /** File that would need editing, when there is one. */
  file?: string;
}

export interface RenameOptions {
  /** Without this the call is a preflight: it reports and moves nothing. */
  confirm?: boolean;
  /** Proceed despite live sessions. Never overrides a path or name refusal. */
  force?: boolean;
  liveSessions?: LiveSession[];
  hosts?: Host[];
}

export interface RenamePlan {
  accountId: string;
  newId: string;
  fromDir: string;
  toDir: string;
  /** Everything that points at the old path or the old id. */
  consequences: Consequence[];
  /** Editor settings files naming the old path. The caller re-points them. */
  rebind: Host[];
  /** Dotted settings keys holding the old account id. The caller rewrites them. */
  settingsReferences: string[];
  liveSessions: LiveSession[];
  blockers: Refusal[];
  moved: boolean;
}

const NAME_RE = /^[^./\\][^/\\]*$/;

/**
 * Rename an account's directory.
 *
 * This is shipped behind `confirm` rather than as a preflight-only refusal,
 * because the one thing that made it genuinely dangerous turns out not to bite:
 * the shared-history symlinks Baton writes are absolute, so they still resolve
 * after the directory moves. What does not follow the move is every reference
 * held elsewhere — editor settings, rotation lists, aliases — so those come
 * back in the plan for the caller to fix. A relative symlink inside the
 * directory would break, and is a hard refusal.
 *
 * For a cosmetic change, prefer `setAlias` in settings.ts: it renames nothing
 * on disk and has no consequences at all.
 */
export function renameAccount(
  provider: Provider,
  account: Account,
  newId: string,
  opts: RenameOptions = {},
): RenamePlan {
  const fromDir = path.resolve(account.configDir);
  const base = path.basename(fromDir);
  const prefix = base.endsWith(account.id) ? base.slice(0, base.length - account.id.length) : '.claude-';
  const toDir = path.join(path.dirname(fromDir), `${prefix}${newId}`);

  const blockers: Refusal[] = [];
  const consequences: Consequence[] = [];

  if (!exists(fromDir)) {
    blockers.push({ code: 'not-found', message: `${fromDir} does not exist.`, overridable: false });
  }
  if (!newId.trim() || !NAME_RE.test(newId) || newId === account.id) {
    blockers.push({
      code: 'invalid-name',
      message: `"${newId}" is not a usable account name: it must not be empty, contain a path separator, start with a dot, or match the current name.`,
      overridable: false,
    });
  }
  if (exists(toDir)) {
    blockers.push({ code: 'target-exists', message: `${toDir} already exists.`, overridable: false });
  }
  if (account.isDefault) {
    blockers.push({
      code: 'default-account',
      message: `${account.id} is the implicit ${provider.envVar} directory. Renaming it stops being the fallback, and its ${provider.sharePolicy.merged.map((m) => m.file).join(', ')} lives outside the directory and would not move with it.`,
      overridable: false,
    });
  }
  if (/\s/.test(newId)) {
    consequences.push({
      kind: 'note',
      detail: `"${newId}" contains a space. It works, but every command that mentions the path has to quote it.`,
    });
  }

  const sessions = sessionsFor(account, opts.liveSessions ?? findLiveSessions([provider], [account]));
  for (const s of sessions) {
    consequences.push({
      kind: 'session',
      detail: `pid ${s.pid}${s.editorHint ? ` in ${s.editorHint}` : ''} is running against the old path and will keep writing to it until it is restarted`,
    });
  }
  if (sessions.length) {
    blockers.push({
      code: 'live-sessions',
      message: `${sessions.length} live session(s) are using ${fromDir}. Quit them first, or pass force.`,
      overridable: true,
    });
  }

  const hosts = opts.hosts ?? provider.discoverHosts();
  const rebind = hostsFor(account, hosts).filter((h) => h.configDir);
  for (const h of rebind) {
    consequences.push({
      kind: 'host',
      detail: `${h.label} names the old path in its ${provider.envVar} settings and would point at a directory that no longer exists`,
      file: h.configFile,
    });
  }

  const settings = loadSettings();
  const settingsReferences: string[] = [];
  for (const [hostId, id] of Object.entries(settings.defaultAccountByHost)) {
    if (id === account.id) settingsReferences.push(`defaultAccountByHost.${hostId}`);
  }
  if (settings.autoSwitch.rotation.includes(account.id)) settingsReferences.push('autoSwitch.rotation');
  if (account.id in settings.display.aliases) settingsReferences.push(`display.aliases.${account.id}`);
  for (const key of settingsReferences) {
    consequences.push({ kind: 'setting', detail: `${key} still holds the old id "${account.id}"`, file: 'settings.json' });
  }

  for (const entry of readEntries(fromDir)) {
    if (entry.kind !== 'symlink') continue;
    const full = path.join(fromDir, entry.name);
    let raw: string;
    try {
      raw = fs.readlinkSync(full);
    } catch {
      continue;
    }
    if (path.isAbsolute(raw)) {
      consequences.push({ kind: 'link', detail: `${entry.name} -> ${raw} is absolute and survives the move` });
    } else {
      blockers.push({
        code: 'relative-link',
        message: `${entry.name} is a relative symlink (-> ${raw}) and would break when the directory moves.`,
        overridable: false,
      });
    }
  }

  const blocking = blockers.filter((b) => !b.overridable || !opts.force);
  const plan: RenamePlan = {
    accountId: account.id,
    newId,
    fromDir,
    toDir,
    consequences,
    rebind,
    settingsReferences,
    liveSessions: sessions,
    blockers,
    moved: false,
  };

  if (!opts.confirm) return plan;
  if (blocking.length) throw new LifecycleError(blocking);

  fs.renameSync(fromDir, toDir);
  plan.moved = true;
  return plan;
}
