import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginSnapshot,
  withSnapshot,
  backupEntry,
  listSnapshots,
  getSnapshot,
  pruneSnapshots,
  restoreSnapshot,
  backupStats,
  resolvePolicy,
  snapshotId,
  DEFAULT_POLICY,
} from '../src/core/backups.ts';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-backups-'));
  home = path.join(root, '.baton');
  process.env.BATON_HOME = home;
});

const backupsRoot = () => path.join(home, 'backups');

const snapshotDirs = () => {
  try {
    return fs.readdirSync(backupsRoot()).sort();
  } catch {
    return [];
  }
};

function file(rel: string, body: string): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, 'utf8');
  return f;
}

/** A directory of `count` files of `size` bytes each, for size-budget tests. */
function tree(rel: string, count: number, size: number): string {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(d, `f${i}.jsonl`), 'x'.repeat(size), 'utf8');
  }
  return d;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 11, 21, 21, 36, 188);

/** One finished snapshot holding `payload`, stamped at `now`. */
function snapshotOf(label: string, payload: string, now: number): string {
  const snap = beginSnapshot(label, { now });
  snap.add(payload, `${label}-tag`);
  snap.finish();
  return snap.id;
}

test('one operation produces exactly one snapshot directory', () => {
  const a = file('one/.claude.json', '{"a":1}');
  const b = tree('two/projects', 3, 1000);

  const { summary, result } = withSnapshot(
    'link',
    (snap) => {
      snap.add(a, 'one-prelink');
      snap.add(b, 'two-prelink');
      return 'linked';
    },
    { now: T0 },
  );

  assert.equal(result, 'linked');
  assert.deepEqual(snapshotDirs(), ['2026-09-11T21-21-36-188Z-link']);
  assert.equal(summary.entries, 2);
  assert.equal(summary.bytes, 7 + 3000);
  assert.ok(summary.manifestPath && fs.existsSync(summary.manifestPath));
});

test('nested operations join the snapshot already open', () => {
  const a = file('one/.claude.json', 'A');
  const b = file('two/.claude.json', 'B');

  withSnapshot('link', () => {
    // What `link --all` does: one command, several accounts, one snapshot.
    withSnapshot('link', () => backupEntry(a, 'one-prelink'));
    withSnapshot('link', () => backupEntry(b, 'two-prelink'));
  });

  assert.equal(snapshotDirs().length, 1);
  assert.deepEqual(
    listSnapshots()[0]!.entries.map((e) => e.tag),
    ['one-prelink', 'two-prelink'],
  );
});

test('a stray backupEntry still lands in a snapshot of its own', () => {
  backupEntry(file('one/settings.json', '{}'), 'cursor-preswitch');
  const snaps = listSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]!.label, 'cursor-preswitch');
  assert.equal(snaps[0]!.degraded, false);
});

test('ids are stamped once, sortable, and safe as directory names', () => {
  assert.equal(snapshotId('switch:cursor', T0), '2026-09-11T21-21-36-188Z-switch-cursor');
  assert.ok(snapshotId('a', T0) < snapshotId('a', T0 + 1000), 'lexical order is time order');

  const odd = beginSnapshot('switch: My Editor (beta) / 2', { now: T0 });
  odd.add(file('one/x.json', 'x'), 'odd tag #1');
  odd.finish();
  assert.equal(odd.id, '2026-09-11T21-21-36-188Z-switch-my-editor-beta-2');
  assert.ok(!/[ :#()/]/.test(path.basename(odd.dir)), 'no spaces or odd characters on disk');
  assert.equal(listSnapshots()[0]!.entries[0]!.tag, 'odd tag #1', 'the real tag survives');
});

test('two snapshots begun in the same millisecond do not collide', () => {
  snapshotOf('link', file('one/a', 'a'), T0);
  snapshotOf('link', file('two/b', 'b'), T0);
  assert.equal(snapshotDirs().length, 2);
  assert.deepEqual(snapshotDirs(), [
    '2026-09-11T21-21-36-188Z-link',
    '2026-09-11T21-21-36-188Z-link-2',
  ]);
});

test('an empty snapshot leaves nothing behind', () => {
  const snap = beginSnapshot('link', { now: T0 });
  assert.equal(snap.add(path.join(root, 'missing'), 'gone'), null);
  const summary = snap.finish();
  assert.equal(summary.entries, 0);
  assert.equal(summary.manifestPath, null);
  assert.deepEqual(snapshotDirs(), [], 'no empty directory left in the backups tree');
});

test('the manifest records where each entry came from and where it went', () => {
  const src = file('one/projects/s.jsonl', 'HISTORY');
  const snap = beginSnapshot('merge', { now: T0 });
  const stored = snap.add(src, 'work-premerge')!;
  snap.finish();

  const raw = JSON.parse(fs.readFileSync(path.join(snap.dir, 'manifest.json'), 'utf8'));
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].originalPath, src);
  assert.equal(raw.entries[0].bytes, 7);
  assert.equal(raw.entries[0].isDir, false);
  assert.ok(!path.isAbsolute(raw.entries[0].storedPath), 'stored path is relative to the snapshot');

  // ...and reading it back resolves to the copy on disk.
  const record = getSnapshot(snap.id)!;
  assert.equal(record.entries[0]!.storedPath, stored);
  assert.equal(fs.readFileSync(record.entries[0]!.storedPath, 'utf8'), 'HISTORY');
});

test('entries sharing a tag and a name do not overwrite each other', () => {
  const a = file('one/projects/s.jsonl', 'ONE');
  const b = file('two/projects/s.jsonl', 'TWO');
  const snap = beginSnapshot('link', { now: T0 });
  const first = snap.add(a, 'prelink')!;
  const second = snap.add(b, 'prelink')!;
  snap.finish();

  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'ONE');
  assert.equal(fs.readFileSync(second, 'utf8'), 'TWO');
});

test('listing is newest first', () => {
  const old = snapshotOf('link', file('one/a', 'a'), T0 - 3 * DAY);
  const mid = snapshotOf('switch', file('two/b', 'b'), T0 - DAY);
  const recent = snapshotOf('merge', file('three/c', 'c'), T0);

  assert.deepEqual(
    listSnapshots().map((s) => s.id),
    [recent, mid, old],
  );
});

test('retention deletes oldest first and says why', () => {
  // Five snapshots of 240 KB each, against a 0.5 MB budget.
  const ids = [4, 3, 2, 1, 0].map((d) =>
    snapshotOf(`link${d}`, tree(`acct${d}/projects`, 2, 120_000), T0 - d * DAY),
  );

  const result = pruneSnapshots({ keepCount: 2, maxTotalMb: 0.5, maxAgeDays: 0 }, { now: T0 });

  assert.deepEqual(
    result.deleted.map((d) => d.id),
    [ids[0], ids[1], ids[2]],
    'oldest go first, and only as many as the budget needs',
  );
  assert.ok(result.deleted.every((d) => d.reason === 'size'));
  assert.equal(result.kept, 2);
  assert.equal(result.bytesFreed, 720_000);
  assert.equal(result.bytesRemaining, 480_000);
  assert.equal(result.overBudget, false);
  assert.equal(snapshotDirs().length, 2);
});

test('age prunes regardless of size, and reports the reason', () => {
  const ancient = snapshotOf('link', file('one/a', 'a'), T0 - 30 * DAY);
  const old = snapshotOf('link', file('two/b', 'b'), T0 - 20 * DAY);
  const fresh = snapshotOf('link', file('three/c', 'c'), T0 - DAY);

  const result = pruneSnapshots({ keepCount: 1, maxAgeDays: 14, maxTotalMb: 0 }, { now: T0 });

  assert.deepEqual(result.deleted.map((d) => [d.id, d.reason]), [
    [ancient, 'age'],
    [old, 'age'],
  ]);
  assert.deepEqual(listSnapshots().map((s) => s.id), [fresh]);
});

test('keepCount wins over maxTotalMb: an oversize tree is kept, not emptied', () => {
  for (let d = 2; d >= 0; d--) {
    snapshotOf(`link${d}`, tree(`acct${d}/projects`, 2, 500_000), T0 - d * DAY);
  }

  const result = pruneSnapshots({ keepCount: 3, maxTotalMb: 0.1, maxAgeDays: 1 }, { now: T0 });

  assert.deepEqual(result.deleted, [], 'nothing pruned below the floor, even over budget and over age');
  assert.equal(result.kept, 3);
  assert.equal(result.overBudget, true, 'the caller is told the budget still loses');
  assert.equal(snapshotDirs().length, 3);
});

test('the newest snapshot survives a keepCount of zero', () => {
  const newest = snapshotOf('link', tree('acct/projects', 2, 500_000), T0);
  const result = pruneSnapshots({ keepCount: 0, maxTotalMb: 0.1, maxAgeDays: 0 }, { now: T0 });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(listSnapshots().map((s) => s.id), [newest]);
});

test('maxCount trims down to a ceiling once keepCount is satisfied', () => {
  const ids = [3, 2, 1, 0].map((d) => snapshotOf(`link${d}`, file(`acct${d}/a`, 'a'), T0 - d * DAY));

  const result = pruneSnapshots({ keepCount: 1, maxCount: 2, maxAgeDays: 0, maxTotalMb: 0 }, { now: T0 });

  assert.deepEqual(result.deleted.map((d) => [d.id, d.reason]), [
    [ids[0], 'count'],
    [ids[1], 'count'],
  ]);
  assert.equal(result.kept, 2);
});

test('a dry run prunes nothing but reports everything', () => {
  const ids = [2, 1, 0].map((d) => snapshotOf(`link${d}`, tree(`acct${d}/p`, 2, 120_000), T0 - d * DAY));
  const before = snapshotDirs();

  const result = pruneSnapshots({ keepCount: 1, maxTotalMb: 0.2, maxAgeDays: 0 }, { dryRun: true, now: T0 });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.deleted.map((d) => d.id), [ids[0], ids[1]]);
  assert.equal(result.bytesFreed, 480_000);
  assert.deepEqual(snapshotDirs(), before, 'the filesystem is untouched');
});

test('restore puts a file back and is itself undoable', () => {
  const target = file('acct/.claude.json', 'ORIGINAL');
  const id = snapshotOf('premerge', target, T0);
  fs.writeFileSync(target, 'BROKEN', 'utf8');

  const result = restoreSnapshot(id);

  assert.equal(result.restored, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.ok(result.undoSnapshotId, 'the state that was overwritten was snapshotted first');

  // Undo the restore using the snapshot the restore took.
  restoreSnapshot(result.undoSnapshotId!);
  assert.equal(fs.readFileSync(target, 'utf8'), 'BROKEN');
});

test('restore round-trips a directory, including entries added since', () => {
  const dir = tree('acct/projects', 2, 10);
  const id = snapshotOf('prelink', dir, T0);
  fs.rmSync(path.join(dir, 'f0.jsonl'));
  fs.writeFileSync(path.join(dir, 'later.jsonl'), 'LATER', 'utf8');

  restoreSnapshot(id);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['f0.jsonl', 'f1.jsonl']);
  const undo = listSnapshots()[0]!;
  assert.equal(undo.label, 'pre-restore');
  assert.deepEqual(
    fs.readdirSync(undo.entries[0]!.storedPath).sort(),
    ['f1.jsonl', 'later.jsonl'],
    'what was there at restore time is recoverable',
  );
});

test('a dry-run restore changes nothing and takes no undo snapshot', () => {
  const target = file('acct/.claude.json', 'ORIGINAL');
  const id = snapshotOf('premerge', target, T0);
  fs.writeFileSync(target, 'BROKEN', 'utf8');

  const result = restoreSnapshot(id, { dryRun: true });

  assert.equal(result.restored, 1);
  assert.equal(result.undoSnapshotId, null);
  assert.equal(fs.readFileSync(target, 'utf8'), 'BROKEN');
  assert.equal(snapshotDirs().length, 1, 'no pre-restore snapshot was taken');
});

test('only: restores one tagged entry and leaves the rest alone', () => {
  const a = file('one/.claude.json', 'A-OLD');
  const b = file('two/.claude.json', 'B-OLD');
  const snap = beginSnapshot('link', { now: T0 });
  snap.add(a, 'one-prelink');
  snap.add(b, 'two-prelink');
  snap.finish();
  fs.writeFileSync(a, 'A-NEW', 'utf8');
  fs.writeFileSync(b, 'B-NEW', 'utf8');

  const result = restoreSnapshot(snap.id, { only: ['one-prelink'] });

  assert.equal(result.restored, 1);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A-OLD');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B-NEW');
  assert.throws(() => restoreSnapshot(snap.id, { only: ['nope'] }), /nothing tagged nope/);
});

test('restore refuses an entry whose parent directory is gone', () => {
  const target = file('acct/nested/.claude.json', 'ORIGINAL');
  const id = snapshotOf('prelink', target, T0);
  fs.rmSync(path.join(root, 'acct/nested'), { recursive: true, force: true });

  const result = restoreSnapshot(id);

  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 1);
  assert.match(result.entries[0]!.reason ?? '', /no longer exists/);
  assert.equal(result.undoSnapshotId, null);
  assert.throws(() => restoreSnapshot('not-a-snapshot'), /No backup snapshot/);
});

test('snapshots with no manifest still list, marked degraded', () => {
  // The layout this user already has on disk: a bare timestamp directory.
  const legacy = path.join(backupsRoot(), '2026-09-11T21-21-36-188Z');
  fs.mkdirSync(path.join(legacy, 'default-prelink', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'default-prelink', 'projects', 's.jsonl'), 'x'.repeat(400));

  const snaps = listSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]!.degraded, true);
  assert.equal(snaps[0]!.createdAt, '2026-09-11T21:21:36.188Z', 'time read from the directory name');
  assert.equal(snaps[0]!.bytes, 400);
  assert.deepEqual(snaps[0]!.entries.map((e) => e.tag), ['default-prelink']);

  // It can be listed and pruned, but never restored: nothing recorded where it came from.
  const result = restoreSnapshot(snaps[0]!.id);
  assert.equal(result.restored, 0);
  assert.match(result.entries[0]!.reason ?? '', /no original path recorded/);
});

test('a corrupt manifest degrades instead of breaking the listing', () => {
  const good = snapshotOf('link', file('one/a', 'aa'), T0);
  const bad = beginSnapshot('switch', { now: T0 - DAY });
  bad.add(file('two/b', 'bbb'), 'two-preswitch');
  bad.finish();
  fs.writeFileSync(path.join(bad.dir, 'manifest.json'), '{ not json', 'utf8');

  const snaps = listSnapshots();
  assert.deepEqual(snaps.map((s) => [s.id, s.degraded]), [
    [good, false],
    [bad.id, true],
  ]);
  assert.equal(snaps[1]!.bytes, 3, 'size recovered by walking the tree');
});

test('a directory whose name has spaces and odd characters is handled', () => {
  const odd = path.join(backupsRoot(), 'old backup #1 (keep?)');
  fs.mkdirSync(path.join(odd, 'stuff'), { recursive: true });
  fs.writeFileSync(path.join(odd, 'stuff', 'x'), 'x'.repeat(50));
  const ancient = new Date(T0 - 90 * DAY);
  fs.utimesSync(odd, ancient, ancient);
  const fresh = snapshotOf('link', file('one/a', 'a'), T0);

  const snaps = listSnapshots();
  assert.deepEqual(snaps.map((s) => s.id), [fresh, 'old backup #1 (keep?)']);
  assert.equal(snaps[1]!.bytes, 50);

  const result = pruneSnapshots({ keepCount: 1, maxAgeDays: 14, maxTotalMb: 0 }, { now: T0 });
  assert.deepEqual(result.deleted.map((d) => [d.id, d.reason]), [['old backup #1 (keep?)', 'age']]);
  assert.ok(!fs.existsSync(odd));
});

test('an empty backups tree reports zeroes rather than failing', () => {
  assert.deepEqual(listSnapshots(), []);
  assert.equal(getSnapshot('anything'), null);

  const pruned = pruneSnapshots(undefined, { now: T0 });
  assert.deepEqual(pruned.deleted, []);
  assert.equal(pruned.bytesRemaining, 0);
  assert.equal(pruned.overBudget, false);

  const stats = backupStats({ now: T0 });
  assert.deepEqual(
    { count: stats.count, totalBytes: stats.totalBytes, oldest: stats.oldestAt, newest: stats.newestAt },
    { count: 0, totalBytes: 0, oldest: null, newest: null },
  );
  assert.equal(stats.wouldPrune, 0);
  assert.deepEqual(stats.policy, DEFAULT_POLICY);
});

test('stats describe the tree and what a prune would do', () => {
  const ids = [2, 1, 0].map((d) => snapshotOf(`link${d}`, tree(`acct${d}/p`, 2, 120_000), T0 - d * DAY));

  const stats = backupStats({ policy: { keepCount: 1, maxTotalMb: 0.2, maxAgeDays: 0 }, now: T0 });

  assert.equal(stats.count, 3);
  assert.equal(stats.totalBytes, 720_000);
  assert.equal(stats.oldestAt, new Date(T0 - 2 * DAY).toISOString());
  assert.equal(stats.newestAt, new Date(T0).toISOString());
  assert.equal(stats.wouldPrune, 2);
  assert.equal(stats.overBudget, true, 'even after pruning, keepCount holds it over budget');
  assert.equal(snapshotDirs().length, 3, 'stats never delete anything');
  assert.equal(listSnapshots()[0]!.id, ids[2]);
});

test('a nonsense policy falls back to the defaults instead of deleting everything', () => {
  assert.deepEqual(resolvePolicy(), DEFAULT_POLICY);
  assert.deepEqual(
    resolvePolicy({ keepCount: -5, maxTotalMb: Number.NaN, maxAgeDays: -1 }),
    DEFAULT_POLICY,
  );
  assert.equal(resolvePolicy({ keepCount: 0 }).keepCount, 1);
  assert.equal(resolvePolicy({ maxCount: 0 }).maxCount, 1);
});

test('an operation that throws keeps the backups it already took', () => {
  const a = file('one/.claude.json', 'A');
  assert.throws(() =>
    withSnapshot('link', (snap) => {
      snap.add(a, 'one-prelink');
      throw new Error('link failed halfway');
    }),
  );

  const snaps = listSnapshots();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]!.degraded, false, 'the manifest was still written');
  assert.equal(snaps[0]!.entries.length, 1);
});
