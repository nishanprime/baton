import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appHome, sharedStore, exists } from './paths.ts';
import { PROVIDERS } from './registry.ts';
import type { LiveSession } from './sessions.ts';
import type { Provider } from './types.ts';

/**
 * Which account produced a session.
 *
 * Transcripts never record the account, and pooling merged every account's
 * history into one store, so existing conversations cannot be attributed after
 * the fact — that is a property of the data, not a gap to close. What can be
 * done is writing down what the process table shows while a session is alive,
 * which makes attribution possible from the first observation onward.
 *
 * What a running session actually reveals, checked on live processes rather
 * than assumed:
 *
 *   - The account. CLAUDE_CONFIG_DIR is in the process environment, which is
 *     how sessions.ts already resolves accountId. Reliable.
 *   - cwd and process start time, from lsof (darwin) or /proc (linux). Always
 *     there on POSIX; nothing equivalent is wired up for win32.
 *   - The transcript session id: ONLY when the command line carries it, which
 *     means a resumed session (--resume=<uuid>) or one launched with an
 *     explicit --session-id. A freshly started session does not expose it
 *     anywhere a bystander can read. Both plausible sources were checked and
 *     neither works: the ide/*.lock files hold the editor's pid, workspace
 *     folders, transport and a websocket auth token but no session id, and the
 *     CLI closes the .jsonl between appends, so the transcript never shows up
 *     in the process's open files either.
 *
 * So there are two kinds of record, and the difference is not cosmetic:
 *
 *   sid:<uuid>   the session names itself. Looking it up by session id later
 *                is exact.
 *   proc:<...>   keyed by provider + pid + start time. It cannot be looked up
 *                by session id at all, because the id was never visible. It can
 *                only be matched back to a transcript or a limit event by cwd
 *                and time window, which resolveAttribution does and labels
 *                'inferred'.
 *
 * Nothing here guesses. When two accounts ran in the same directory in the same
 * window, the match is ambiguous and the answer is null.
 */

const FILE_VERSION = 1;

/** Keep the map small enough to read on every poll without thinking about it. */
export const MAX_ATTRIBUTION_RECORDS = 1000;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Slack either side of an observed window when matching by cwd and time.
 *
 * A session is only seen on polls, so its real lifetime starts before the first
 * observation and ends after the last one. This is the amount of that gap we
 * are willing to cover; past it, an inferred match stops being evidence.
 */
export const MATCH_GRACE_MS = 5 * 60_000;

export type AttributionConfidence = 'exact' | 'inferred';

export interface AttributionRecord {
  providerId: string;
  accountId: string;
  /** Transcript session id, when the process named one. Null for most sessions. */
  sessionId: string | null;
  cwd: string | null;
  pid: number;
  /** Process start time, ISO. Pairs with pid, which the OS reuses. */
  startedAt: string | null;
  /** Editor or entrypoint the session was launched from, for display only. */
  editor: string | null;
  firstSeen: string;
  lastSeen: string;
}

interface AttributionFile {
  version: number;
  /** When recording began. Nothing before this can ever be attributed. */
  since: string | null;
  /** True once pruning dropped records, so `since` no longer covers everything seen. */
  truncated: boolean;
  records: Record<string, AttributionRecord>;
}

export interface Attribution {
  accountId: string;
  confidence: AttributionConfidence;
  /** When this session was first observed running under that account. */
  recordedAt: string;
}

export interface AttributionStats {
  /** Records held right now. */
  recorded: number;
  /** When recording began, or null if it never has. */
  since: string | null;
  /** True when pruning dropped older records, so `since` covers less than it says. */
  truncated: boolean;
  coverage: {
    /** Transcripts in the pooled store. */
    transcripts: number;
    /** Of those, ones created since recording began — the only ones we could have caught. */
    inRange: number;
    /** Of those in range, ones a session id record names. */
    attributed: number;
    /** attributed / inRange, or null when nothing is in range yet. */
    fraction: number | null;
    /**
     * Sessions observed running but not linkable to a transcript, because the
     * process never named its session id. Real usage we can attribute by cwd
     * and time, but not by id.
     */
    observedOnly: number;
  };
}

const attributionPath = (): string => path.join(appHome(), 'attribution.json');

const emptyFile = (): AttributionFile => ({
  version: FILE_VERSION,
  since: null,
  truncated: false,
  records: {},
});

/* ------------------------------------------------------------------ probing */

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

interface Probe {
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
}

/** A session id the command line gives away: resumed, or launched with one. */
const SESSION_ID_RE = /--(?:resume|session-id)[= ]([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})/;

/** `ps` prints lstart as "Fri Sep 11 16:53:43 2026", which Date parses. */
const PS_LINE_RE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/;

function startTimesAndCommands(pids: number[]): Map<number, { startedAt: string | null; command: string }> {
  const out = new Map<number, { startedAt: string | null; command: string }>();
  // -ww: the command line carries the session id and must not be cut to width.
  const raw = run('ps', ['-ww', '-o', 'pid=,lstart=,command=', '-p', pids.join(',')]);
  for (const line of raw.split('\n')) {
    const m = PS_LINE_RE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[2]!.replace(/\s+/g, ' '));
    out.set(Number(m[1]), {
      startedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      command: m[3]!,
    });
  }
  return out;
}

/**
 * Working directory of each pid.
 *
 * linux exposes it as a symlink and needs no subprocess; darwin needs lsof, so
 * every pid goes in one call rather than one call each.
 */
function cwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();

  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch { /* process gone, or not ours */ }
    }
    return out;
  }

  const raw = run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
  let pid = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function probeProcesses(pids: number[]): Map<number, Probe> {
  const out = new Map<number, Probe>();
  if (!pids.length || process.platform === 'win32') return out;

  const meta = startTimesAndCommands(pids);
  const dirs = cwds(pids);

  for (const pid of pids) {
    const m = meta.get(pid);
    out.set(pid, {
      sessionId: m ? SESSION_ID_RE.exec(m.command)?.[1] ?? null : null,
      cwd: dirs.get(pid) ?? null,
      startedAt: m?.startedAt ?? null,
    });
  }
  return out;
}

/* ------------------------------------------------------------- file storage */

let cache: { file: string; mtimeMs: number; size: number; data: AttributionFile } | null = null;

/** Drop the in-process copy. For tests, and for a GUI that wants a fresh read. */
export function clearAttributionCache(): void {
  cache = null;
}

/** Parse the file, or start a new one. The result is never shared with a caller. */
function parseFile(f: string): AttributionFile {
  let data: AttributionFile;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<AttributionFile>;
    data =
      raw.version === FILE_VERSION && raw.records && typeof raw.records === 'object'
        ? { version: FILE_VERSION, since: raw.since ?? null, truncated: raw.truncated === true, records: raw.records }
        : emptyFile();
  } catch {
    // A half-written or hand-edited file loses its contents rather than taking
    // the caller down. Attribution is additive; it rebuilds from the next poll.
    data = emptyFile();
  }
  return data;
}

/**
 * The map as it is on disk. The returned object is shared with the cache, so
 * callers read it and never mutate it — recordObservation uses readForUpdate.
 */
function readFile(): AttributionFile {
  const f = attributionPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f);
  } catch {
    return emptyFile();
  }
  if (cache && cache.file === f && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.data;
  }

  const data = parseFile(f);
  cache = { file: f, mtimeMs: stat.mtimeMs, size: stat.size, data };
  return data;
}

/**
 * A private copy to mutate, read from disk rather than from the cache.
 *
 * Called under the lock, so what is on disk already includes whatever another
 * poller wrote, and this process's own stale copy would silently drop it.
 */
function readForUpdate(): AttributionFile {
  return parseFile(attributionPath());
}

/** Replace the file in one step, so a reader never sees a partial write. */
function writeFile(data: AttributionFile): void {
  const f = attributionPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, f);
  cache = null;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 3_000;

/**
 * Serialise read-modify-write across processes.
 *
 * mkdir is atomic on every platform we care about, which makes it a lock with
 * no dependencies. The atomic rename in writeFile already rules out a torn
 * file; this is what stops two pollers from each writing a copy of the map that
 * is missing the other's observations.
 *
 * Failing to take the lock is not fatal. Losing one poll's observations is a
 * gap that the next poll fills; refusing to run is worse.
 */
function withLock<T>(fn: () => T): T {
  const lock = path.join(appHome(), 'attribution.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        // A holder that died before cleaning up must not block every later poll.
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* someone else got there first */ }
      sleep(15);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* already gone */ }
    }
  }
}

/**
 * Keep the map bounded.
 *
 * When records are dropped, `since` moves up to the oldest one still held —
 * coverage is measured against that window, and leaving it pointing at a period
 * whose records are gone would report a coverage figure that cannot be met.
 */
function prune(data: AttributionFile): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  const kept = Object.entries(data.records)
    .filter(([, r]) => Date.parse(r.lastSeen) >= cutoff)
    .sort((a, b) => Date.parse(b[1].lastSeen) - Date.parse(a[1].lastSeen))
    .slice(0, MAX_ATTRIBUTION_RECORDS);

  if (kept.length === Object.keys(data.records).length) return;

  data.records = Object.fromEntries(kept);
  data.truncated = true;
  const oldest = kept.reduce<string | null>(
    (acc, [, r]) => (!acc || r.firstSeen < acc ? r.firstSeen : acc),
    null,
  );
  if (oldest) data.since = oldest;
}

/* ------------------------------------------------------------------- public */

/**
 * Write down which account each live session is running under. Call on each poll.
 *
 * Returns how many sessions were recorded. Sessions whose account could not be
 * resolved are skipped rather than recorded as unknown: a record that does not
 * name an account is not attribution.
 */
export function recordObservation(provider: Provider, liveSessions: LiveSession[]): number {
  const mine = liveSessions.filter((s) => s.providerId === provider.id && s.accountId);
  if (!mine.length) return 0;

  // Probe outside the lock: it shells out, and holding a cross-process lock
  // through a subprocess would make every other poller wait on ps and lsof.
  const probes = probeProcesses(mine.map((s) => s.pid));
  const now = new Date().toISOString();

  return withLock(() => {
    const data = readForUpdate();
    let recorded = 0;

    for (const s of mine) {
      const probe = probes.get(s.pid);
      const startedAt = probe?.startedAt ?? null;
      const sessionId = probe?.sessionId ?? null;
      const procKey = `proc:${provider.id}:${s.pid}:${startedAt ?? 'unknown'}`;
      const key = sessionId ? `sid:${sessionId}` : procKey;

      // A session first seen before its id was known keeps its original
      // first-seen time when the id turns up, rather than looking newer.
      const prior = data.records[key] ?? (sessionId ? data.records[procKey] : undefined);
      if (sessionId && data.records[procKey]) delete data.records[procKey];

      data.records[key] = {
        providerId: provider.id,
        accountId: s.accountId!,
        sessionId,
        cwd: probe?.cwd ?? null,
        pid: s.pid,
        startedAt,
        editor: s.editorHint ?? s.entrypoint ?? null,
        firstSeen: prior?.firstSeen ?? now,
        lastSeen: now,
      };
      recorded++;
    }

    data.since ??= now;
    prune(data);
    writeFile(data);
    return recorded;
  });
}

/** The account that produced a transcript, by session id. Exact matches only. */
export function attributionFor(sessionId: string): string | null {
  return readFile().records[`sid:${sessionId}`]?.accountId ?? null;
}

/**
 * The account behind a session, using the session id when it was ever visible
 * and falling back to the directory and time a session was observed running in.
 *
 * The fallback answers null when no observation covers the moment, and also
 * when more than one account does — two accounts in the same directory in the
 * same window is exactly the case where a guess would be wrong.
 */
export function resolveAttribution(
  sessionId: string | null,
  hint: { cwd?: string | null; at?: string | null } = {},
): Attribution | null {
  const data = readFile();

  const at = hint.at ? Date.parse(hint.at) : Number.NaN;

  if (sessionId) {
    const exact = data.records[`sid:${sessionId}`];
    // A session id is not a stable key for an account: a conversation can be
    // resumed later under a different one, and the record only describes the
    // window it was actually observed in. Answering from the id alone reported
    // a limit hit hours earlier as belonging to whichever account happens to
    // hold that transcript now — which is how the account the user switched TO
    // got shown as spent, and the one that ran out as ready.
    if (exact) {
      const withinObserved =
        !Number.isFinite(at) ||
        (Date.parse(exact.firstSeen) - MATCH_GRACE_MS <= at &&
          at <= Date.parse(exact.lastSeen) + MATCH_GRACE_MS);
      if (withinObserved) {
        return { accountId: exact.accountId, confidence: 'exact', recordedAt: exact.firstSeen };
      }
    }
  }

  if (!hint.cwd || !Number.isFinite(at)) return null;

  // A transcript records the logical cwd the session was started with; lsof
  // reports it with every symlink resolved. On macOS that alone is the
  // difference between /var/... and /private/var/..., so both spellings of each
  // side have to be considered or a legitimate match is missed.
  const wanted = new Set([path.resolve(hint.cwd), canonical(hint.cwd)]);

  const covering = Object.values(data.records).filter(
    (r) =>
      r.cwd &&
      (wanted.has(path.resolve(r.cwd)) || wanted.has(canonical(r.cwd))) &&
      Date.parse(r.firstSeen) - MATCH_GRACE_MS <= at &&
      at <= Date.parse(r.lastSeen) + MATCH_GRACE_MS,
  );

  const accounts = new Set(covering.map((r) => r.accountId));
  if (accounts.size !== 1) return null;

  const earliest = covering.reduce((a, b) => (a.firstSeen <= b.firstSeen ? a : b));
  return { accountId: earliest.accountId, confidence: 'inferred', recordedAt: earliest.firstSeen };
}

/** Absolute path with symlinks resolved, falling back when the path is gone. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Every record held, newest observation first. */
export function listAttributions(): AttributionRecord[] {
  return Object.values(readFile().records).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * How much of the pooled history recording can actually name.
 *
 * The denominator is transcripts created since recording began, not every
 * transcript — measuring against history that predates recording would report a
 * number that can never improve and says nothing about whether it is working.
 */
export function attributionStats(providers: Provider[] = PROVIDERS): AttributionStats {
  const data = readFile();
  const records = Object.values(data.records);
  const named = new Set(records.map((r) => r.sessionId).filter((id): id is string => !!id));
  const sinceMs = data.since ? Date.parse(data.since) : Number.NaN;

  let transcripts = 0;
  let inRange = 0;
  let attributed = 0;

  for (const provider of providers) {
    const root = path.join(sharedStore(provider.id), 'projects');
    if (!exists(root)) continue;

    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const name of names) {
        transcripts++;
        let born = 0;
        try {
          const stat = fs.statSync(path.join(root, dir, name));
          // Creation time, not mtime: a conversation started before recording
          // began and appended to afterwards was still never attributable.
          born = stat.birthtimeMs || stat.mtimeMs;
        } catch { /* counted, but out of range */ }

        if (!Number.isFinite(sinceMs) || born < sinceMs) continue;
        inRange++;
        if (named.has(name.slice(0, -'.jsonl'.length))) attributed++;
      }
    }
  }

  return {
    recorded: records.length,
    since: data.since,
    truncated: data.truncated,
    coverage: {
      transcripts,
      inRange,
      attributed,
      fraction: inRange ? Math.min(1, attributed / inRange) : null,
      observedOnly: records.filter((r) => !r.sessionId).length,
    },
  };
}
