import fs from 'node:fs';
import path from 'node:path';
import { backupsPath, exists, isDir } from './paths.ts';
import { loadSettings } from './settings.ts';

/**
 * Operation-scoped safety copies.
 *
 * Every backup Baton takes belongs to one logical operation — a link, a
 * switch, a merge — so they all land in one snapshot directory described by
 * one manifest. The earlier approach stamped a fresh timestamp per copied
 * entry, which meant a single `link --all` scattered its backups across
 * fifteen sibling directories, one of them a full copy of projects/. Nothing
 * could prune them because nothing recorded how they grouped, what they were,
 * or where they came from.
 *
 * The manifest is the point: listing, pruning and restoring all read it
 * instead of walking the tree, and it is what makes a restore possible at all
 * — a copy with no record of its original path is just disk use.
 */

const MANIFEST = 'manifest.json';
const MANIFEST_VERSION = 1;
const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

export interface SnapshotEntry {
  /** Why this path was copied, e.g. "work-prelink". Also the restore filter. */
  tag: string;
  /** Absolute path the copy came from, and the path a restore writes back to. */
  originalPath: string;
  /** Absolute path of the copy inside the snapshot directory. */
  storedPath: string;
  bytes: number;
  isDir: boolean;
}

/** One finished snapshot, as read back from its manifest. */
export interface SnapshotRecord {
  id: string;
  label: string;
  createdAt: string;
  bytes: number;
  entries: SnapshotEntry[];
  dir: string;
  /** True when the manifest was missing or unreadable and this was rebuilt from disk. */
  degraded: boolean;
}

export interface SnapshotSummary {
  id: string;
  label: string;
  dir: string;
  createdAt: string;
  /** How many paths have been copied in. */
  entries: number;
  bytes: number;
  /** The written manifest, or null while the snapshot is open or if it held nothing. */
  manifestPath: string | null;
}

/** An open snapshot. Everything added lands in the same directory. */
export interface Snapshot {
  readonly id: string;
  readonly label: string;
  readonly dir: string;
  readonly createdAt: string;
  /** Copy a path in. Returns where it was stored, or null if there was nothing there. */
  add(src: string, tag: string): string | null;
  /** Totals so far, without closing the snapshot. */
  stats(): SnapshotSummary;
  /** Write the manifest. Idempotent; an empty snapshot removes its own directory. */
  finish(): SnapshotSummary;
  /** Throw the whole snapshot away, e.g. when the operation never happened. */
  discard(): void;
}

export interface BackupPolicy {
  /** Newest snapshots always kept, whatever the other limits say. */
  keepCount: number;
  /** Total budget for the backups tree. 0 means no budget. */
  maxTotalMb: number;
  /** Snapshots older than this are deleted. 0 means no age limit. */
  maxAgeDays: number;
  /** Optional ceiling on how many snapshots to keep at all. Off by default. */
  maxCount?: number;
}

export const DEFAULT_POLICY: BackupPolicy = {
  keepCount: 10,
  // A ceiling as well as a floor. Without it, small recent snapshots satisfy
  // both the size and the age budget forever and the count grows unbounded.
  maxCount: 20,
  maxTotalMb: 500,
  maxAgeDays: 14,
};

export type PruneReason = 'age' | 'size' | 'count';

export interface PrunedSnapshot {
  id: string;
  label: string;
  createdAt: string;
  bytes: number;
  reason: PruneReason;
}

export interface PruneResult {
  deleted: PrunedSnapshot[];
  bytesFreed: number;
  bytesRemaining: number;
  /** Snapshots left afterwards. */
  kept: number;
  dryRun: boolean;
  /** True when the tree is still over budget because keepCount won. */
  overBudget: boolean;
  policy: BackupPolicy;
}

export interface RestoreEntryResult {
  tag: string;
  originalPath: string;
  action: 'restored' | 'skipped';
  reason?: string;
}

export interface RestoreResult {
  id: string;
  dryRun: boolean;
  entries: RestoreEntryResult[];
  restored: number;
  skipped: number;
  /** Snapshot of what was overwritten, so the restore is itself undoable. */
  undoSnapshotId: string | null;
}

export interface BackupStats {
  count: number;
  totalBytes: number;
  oldestAt: string | null;
  newestAt: string | null;
  policy: BackupPolicy;
  overBudget: boolean;
  /** How many snapshots a prune would delete right now. */
  wouldPrune: number;
}

interface ManifestFile {
  version: number;
  id: string;
  label: string;
  createdAt: string;
  bytes: number;
  entries: SnapshotEntry[];
}

/** Filesystem-safe piece of a directory name: labels and tags are free text. */
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 40).replace(/[-.]+$/, '') || 'snapshot';
}

/**
 * The one place snapshot ids are built, so tests can pin the clock.
 *
 * Timestamp first keeps plain lexical sort in time order — which listing,
 * pruning and the old directory names all rely on — and the label suffix
 * means a directory says what it was for without opening it.
 */
export function snapshotId(label: string, now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${slug(label)}`;
}

/** Recover the ISO time from an id, including ids written before manifests existed. */
function timeFromId(id: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function labelFromId(id: string): string {
  const rest = id.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-?/, '');
  return rest || 'unknown';
}

/** Bytes a copied path occupies. Symlinks count as the link, never their target. */
function pathBytes(p: string): number {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      total += pathBytes(path.join(p, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function copyInto(src: string, dest: string): void {
  // verbatimSymlinks keeps a linked entry as a link: an account already
  // pointing at the shared store must not be copied as a second full tree.
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true });
}

/** A limit is only honoured if it is a real, non-negative number. */
function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolvePolicy(partial?: Partial<BackupPolicy>): BackupPolicy {
  const p: BackupPolicy = {
    // Below one there is nothing to restore from, which is the whole point.
    keepCount: Math.max(1, Math.floor(num(partial?.keepCount, DEFAULT_POLICY.keepCount))),
    // Budgets stay fractional: half a megabyte is a reasonable thing to ask for.
    maxTotalMb: num(partial?.maxTotalMb, DEFAULT_POLICY.maxTotalMb),
    maxAgeDays: num(partial?.maxAgeDays, DEFAULT_POLICY.maxAgeDays),
  };
  const wanted = partial?.maxCount ?? DEFAULT_POLICY.maxCount;
  if (wanted !== undefined) {
    p.maxCount = Math.max(1, Math.floor(num(wanted, DEFAULT_POLICY.maxCount ?? 20)));
  }
  return p;
}

/**
 * Retention from the "backups" block in settings.
 *
 * Read through a cast rather than the Settings type: the block is hand-editable
 * and may hold a key this module knows about but the schema does not, and a
 * missing or nonsense value has to fall back to the defaults rather than void
 * the budget entirely.
 */
export function policyFromSettings(): BackupPolicy {
  try {
    const raw = loadSettings() as unknown as { backups?: Partial<BackupPolicy> };
    return resolvePolicy(raw.backups);
  } catch {
    return resolvePolicy();
  }
}

/**
 * Claim a directory for this snapshot.
 *
 * mkdir without recursive is the lock: two snapshots begun in the same
 * millisecond cannot both win, so ids stay unique without a counter surviving
 * between processes.
 */
function reserveDir(baseId: string): { id: string; dir: string } {
  const root = backupsPath();
  fs.mkdirSync(root, { recursive: true });
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? baseId : `${baseId}-${n + 1}`;
    const dir = path.join(root, id);
    try {
      fs.mkdirSync(dir);
      return { id, dir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not claim a backup directory for "${baseId}"`);
}

/**
 * Open a snapshot for one operation — 'link', 'switch:cursor', 'merge'.
 *
 * The directory is created now so the id is reserved; finish() removes it
 * again if nothing was added, so a dry run that opens one leaves no trace.
 */
export function beginSnapshot(label: string, opts: { now?: number } = {}): Snapshot {
  const createdAtMs = opts.now ?? Date.now();
  const { id, dir } = reserveDir(snapshotId(label, createdAtMs));
  const createdAt = new Date(createdAtMs).toISOString();
  const entries: SnapshotEntry[] = [];
  let finished = false;
  let manifestWritten = false;

  const summary = (): SnapshotSummary => ({
    id,
    label,
    dir,
    createdAt,
    entries: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
    manifestPath: manifestWritten ? path.join(dir, MANIFEST) : null,
  });

  return {
    id,
    label,
    dir,
    createdAt,
    add(src, tag) {
      if (finished) throw new Error(`Snapshot ${id} is already finished`);
      if (!exists(src)) return null;

      const st = fs.lstatSync(src);
      // A sequence prefix keeps two entries with the same tag and basename —
      // two accounts' projects/, say — from landing on top of each other.
      const seq = String(entries.length + 1).padStart(3, '0');
      const holder = path.join(dir, `${seq}-${slug(tag)}`);
      const dest = path.join(holder, path.basename(src) || 'entry');
      fs.mkdirSync(holder, { recursive: true });
      copyInto(src, dest);

      entries.push({
        tag,
        originalPath: path.resolve(src),
        storedPath: dest,
        bytes: pathBytes(dest),
        isDir: st.isDirectory(),
      });
      return dest;
    },
    stats: summary,
    finish() {
      if (finished) return summary();
      finished = true;
      if (entries.length === 0) {
        try {
          fs.rmdirSync(dir);
        } catch {
          /* something else is in there; leave it for the next listing */
        }
        return summary();
      }
      const manifest: ManifestFile = {
        version: MANIFEST_VERSION,
        id,
        label,
        createdAt,
        bytes: entries.reduce((n, e) => n + e.bytes, 0),
        // Stored paths go in relative, so a backups tree that is moved — or a
        // BATON_HOME that changes — still restores.
        entries: entries.map((e) => ({ ...e, storedPath: path.relative(dir, e.storedPath) })),
      };
      fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      manifestWritten = true;
      return summary();
    },
    discard() {
      finished = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The snapshot the current operation is filling, if one is open. */
let active: Snapshot | null = null;

/**
 * Run an operation with one snapshot open for the whole of it.
 *
 * Nested calls join the snapshot already open rather than starting another,
 * which is what keeps `link --all` to a single directory: the command opens
 * one, and every account it links adds into it.
 */
export function withSnapshot<T>(
  label: string,
  fn: (snap: Snapshot) => T,
  opts: { now?: number } = {},
): { result: T; summary: SnapshotSummary } {
  if (active) {
    const outer = active;
    return { result: fn(outer), summary: outer.stats() };
  }
  const snap = beginSnapshot(label, opts);
  active = snap;
  try {
    const result = fn(snap);
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      throw new Error('withSnapshot is synchronous; finish the work before returning');
    }
    return { result, summary: snap.finish() };
  } finally {
    active = null;
    // Keeps whatever was copied when the operation threw partway through.
    snap.finish();
  }
}

/**
 * Back one path up, into the operation's snapshot when there is one.
 *
 * This is the drop-in for the per-call timestamped copies: callers that know
 * nothing about snapshots still get grouped and restorable backups as soon as
 * something above them opens one.
 */
export function backupEntry(src: string, tag: string): string | null {
  if (active) return active.add(src, tag);
  const snap = beginSnapshot(tag);
  try {
    return snap.add(src, tag);
  } finally {
    snap.finish();
  }
}

/** Rebuild what can be known about a snapshot directory with no usable manifest. */
function reconstruct(dir: string, id: string): SnapshotRecord {
  const entries: SnapshotEntry[] = [];
  let children: string[] = [];
  try {
    children = fs.readdirSync(dir).filter((c) => c !== MANIFEST);
  } catch {
    /* unreadable; report it as an empty degraded snapshot rather than failing */
  }
  for (const child of children.sort()) {
    const stored = path.join(dir, child);
    entries.push({
      tag: child.replace(/^\d{3}-/, ''),
      // Nothing on disk records where this came from, so a restore has to
      // refuse rather than guess a destination.
      originalPath: '',
      storedPath: stored,
      bytes: pathBytes(stored),
      isDir: isDir(stored),
    });
  }
  let mtime: string | null = null;
  try {
    mtime = fs.statSync(dir).mtime.toISOString();
  } catch {
    /* fall through to the epoch below */
  }
  return {
    id,
    label: labelFromId(id),
    createdAt: timeFromId(id) ?? mtime ?? new Date(0).toISOString(),
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
    entries,
    dir,
    degraded: true,
  };
}

function readSnapshot(dir: string, id: string): SnapshotRecord {
  let manifest: ManifestFile;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as ManifestFile;
  } catch {
    return reconstruct(dir, id);
  }
  if (!manifest || !Array.isArray(manifest.entries) || typeof manifest.createdAt !== 'string') {
    return reconstruct(dir, id);
  }
  const entries = manifest.entries.map((e) => ({
    tag: String(e.tag ?? ''),
    originalPath: String(e.originalPath ?? ''),
    storedPath: path.isAbsolute(e.storedPath ?? '')
      ? e.storedPath
      : path.join(dir, e.storedPath ?? ''),
    bytes: typeof e.bytes === 'number' ? e.bytes : 0,
    isDir: Boolean(e.isDir),
  }));
  return {
    id: manifest.id ?? id,
    label: manifest.label ?? labelFromId(id),
    createdAt: manifest.createdAt,
    bytes:
      typeof manifest.bytes === 'number'
        ? manifest.bytes
        : entries.reduce((n, e) => n + e.bytes, 0),
    entries,
    dir,
    degraded: false,
  };
}

/**
 * Every snapshot, newest first.
 *
 * Manifested snapshots cost one small read each; only the ones written before
 * manifests existed — or since corrupted — pay for a walk of their tree.
 */
export function listSnapshots(): SnapshotRecord[] {
  const root = backupsPath();
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: SnapshotRecord[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    // Loose files at the top level are not snapshots and are left alone.
    if (!isDir(dir)) continue;
    out.push(readSnapshot(dir, name));
  }
  return out.sort((a, b) => {
    const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (diff) return diff;
    return b.id.localeCompare(a.id);
  });
}

export function getSnapshot(id: string): SnapshotRecord | null {
  return listSnapshots().find((s) => s.id === id) ?? null;
}

export function deleteSnapshot(id: string): boolean {
  const snap = getSnapshot(id);
  if (!snap) return false;
  fs.rmSync(snap.dir, { recursive: true, force: true });
  return true;
}

function prune(
  snaps: SnapshotRecord[],
  policy: BackupPolicy,
  opts: { dryRun?: boolean; now?: number },
): PruneResult {
  const now = opts.now ?? Date.now();
  const budget = policy.maxTotalMb * MB;
  let remaining = snaps.reduce((n, s) => n + s.bytes, 0);

  // keepCount wins over every other limit, and the newest is kept whatever
  // keepCount says: a backup you cannot restore from is worse than disk use.
  const protectedCount = Math.min(Math.max(1, policy.keepCount), snaps.length);
  const oldestFirst = snaps.slice(protectedCount).reverse();
  const doomed = new Map<string, PruneReason>();

  const condemn = (s: SnapshotRecord, reason: PruneReason) => {
    doomed.set(s.id, reason);
    remaining -= s.bytes;
  };

  if (policy.maxAgeDays > 0) {
    const cutoff = now - policy.maxAgeDays * DAY_MS;
    for (const s of oldestFirst) {
      const at = Date.parse(s.createdAt);
      // An unparseable date is treated as recent; guessing old deletes data.
      if (Number.isFinite(at) && at < cutoff) condemn(s, 'age');
    }
  }

  if (policy.maxCount !== undefined) {
    const ceiling = Math.max(protectedCount, policy.maxCount);
    for (const s of oldestFirst) {
      if (snaps.length - doomed.size <= ceiling) break;
      if (!doomed.has(s.id)) condemn(s, 'count');
    }
  }

  if (budget > 0) {
    for (const s of oldestFirst) {
      if (remaining <= budget) break;
      if (!doomed.has(s.id)) condemn(s, 'size');
    }
  }

  const deleted: PrunedSnapshot[] = [];
  for (const s of oldestFirst) {
    const reason = doomed.get(s.id);
    if (!reason) continue;
    if (!opts.dryRun) fs.rmSync(s.dir, { recursive: true, force: true });
    deleted.push({ id: s.id, label: s.label, createdAt: s.createdAt, bytes: s.bytes, reason });
  }

  return {
    deleted,
    bytesFreed: deleted.reduce((n, d) => n + d.bytes, 0),
    bytesRemaining: remaining,
    kept: snaps.length - deleted.length,
    dryRun: Boolean(opts.dryRun),
    overBudget: budget > 0 && remaining > budget,
    policy,
  };
}

/**
 * Apply retention. Oldest snapshots go first, and keepCount is a floor the
 * size and age limits cannot dig under — `overBudget` in the result is how a
 * caller learns the tree is still large because of that.
 */
export function pruneSnapshots(
  policy?: Partial<BackupPolicy>,
  opts: { dryRun?: boolean; now?: number } = {},
): PruneResult {
  return prune(listSnapshots(), resolvePolicy(policy), opts);
}

/**
 * Put a snapshot's entries back where they came from.
 *
 * The current state is snapshotted first, under 'pre-restore', so restoring
 * the wrong thing is itself undoable — restores are run by people who have
 * just realised something went wrong, and they should not have to be right
 * twice in a row.
 */
export function restoreSnapshot(
  id: string,
  opts: { dryRun?: boolean; only?: string[]; now?: number } = {},
): RestoreResult {
  const snap = getSnapshot(id);
  if (!snap) throw new Error(`No backup snapshot "${id}"`);

  const wanted = opts.only?.length
    ? snap.entries.filter((e) => opts.only!.includes(e.tag))
    : snap.entries;
  if (wanted.length === 0) {
    throw new Error(
      opts.only?.length
        ? `Snapshot ${id} has nothing tagged ${opts.only.join(', ')}`
        : `Snapshot ${id} recorded no entries`,
    );
  }

  const results: RestoreEntryResult[] = [];
  const planned: SnapshotEntry[] = [];
  for (const e of wanted) {
    const skip = (reason: string) =>
      results.push({ tag: e.tag, originalPath: e.originalPath, action: 'skipped', reason });

    if (!e.originalPath) {
      skip('no original path recorded; this snapshot predates manifests');
      continue;
    }
    const parent = path.dirname(e.originalPath);
    if (!isDir(parent)) {
      skip(`${parent} no longer exists, so there is nowhere to put this back`);
      continue;
    }
    if (!exists(e.storedPath)) {
      skip('the backed-up copy is missing from the snapshot');
      continue;
    }
    planned.push(e);
  }

  let undoSnapshotId: string | null = null;
  if (planned.length > 0 && !opts.dryRun) {
    const undo = beginSnapshot('pre-restore', { now: opts.now });
    for (const e of planned) undo.add(e.originalPath, e.tag);
    const summary = undo.finish();
    undoSnapshotId = summary.entries > 0 ? summary.id : null;

    for (const e of planned) {
      fs.rmSync(e.originalPath, { recursive: true, force: true });
      copyInto(e.storedPath, e.originalPath);
    }
  }
  for (const e of planned) {
    results.push({ tag: e.tag, originalPath: e.originalPath, action: 'restored' });
  }

  return {
    id: snap.id,
    dryRun: Boolean(opts.dryRun),
    entries: results,
    restored: planned.length,
    skipped: results.length - planned.length,
    undoSnapshotId,
  };
}

/** What the UI needs to show the backups tree without walking it. */
export function backupStats(
  opts: { policy?: Partial<BackupPolicy>; now?: number } = {},
): BackupStats {
  const snaps = listSnapshots();
  const policy = opts.policy ? resolvePolicy(opts.policy) : policyFromSettings();
  const dry = prune(snaps, policy, { dryRun: true, now: opts.now });
  return {
    count: snaps.length,
    totalBytes: snaps.reduce((n, s) => n + s.bytes, 0),
    oldestAt: snaps.length ? snaps[snaps.length - 1]!.createdAt : null,
    newestAt: snaps.length ? snaps[0]!.createdAt : null,
    policy,
    overBudget: dry.overBudget,
    wouldPrune: dry.deleted.length,
  };
}
