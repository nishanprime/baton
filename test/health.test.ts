import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { accountHealth, UNAVAILABLE_FIELDS, type Field } from '../src/core/health.ts';
import {
  MAX_ATTRIBUTION_RECORDS,
  attributionFor,
  attributionStats,
  clearAttributionCache,
  listAttributions,
  recordObservation,
  resolveAttribution,
} from '../src/core/attribution.ts';
import type { LimitEvent } from '../src/core/limits.ts';
import type { LiveSession } from '../src/core/sessions.ts';
import type { Account, Provider } from '../src/core/types.ts';

/**
 * Attribution reads the real process table, so the tests that cover it spawn
 * real processes rather than faking the probe. That keeps the ps and lsof
 * parsing under test, which is the part that breaks silently.
 */
const POSIX = process.platform !== 'win32';

const SESSION_ID = '2197fe6a-bd8c-4679-8637-0f12f623cceb';
const OTHER_SESSION_ID = '9d1621eb-6e47-4780-88ce-e6e2e593730c';

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-health-'));
  process.env.BATON_HOME = dir;
  clearAttributionCache();
  return dir;
}

const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const provider: Provider = {
  id: 'claude',
  label: 'Claude',
  envVar: 'CLAUDE_CONFIG_DIR',
  sharePolicy: { shared: [], private: [], merged: [] },
  discoverAccounts: () => [],
  discoverHosts: () => [],
  bindHost: () => '',
};

const account = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  label: id,
  configDir: path.join(os.tmpdir(), `baton-cfg-${id}`),
  email: `${id}@example.com`,
  isDefault: false,
  providerId: 'claude',
  ...extra,
});

const session = (pid: number, accountId: string): LiveSession => ({
  pid,
  providerId: 'claude',
  configDir: null,
  accountId,
  entrypoint: 'claude-vscode',
  editorHint: 'cursor',
});

const limitEvent = (extra: Partial<LimitEvent> = {}): LimitEvent => ({
  providerId: 'claude',
  sessionId: SESSION_ID,
  project: 'baton',
  cwd: os.tmpdir(),
  at: new Date().toISOString(),
  resets: '7:40pm (America/New_York)',
  message: "You've hit your session limit · resets 7:40pm (America/New_York)",
  ...extra,
});

/* --------------------------------------------------- real child processes */

const spawned: ChildProcess[] = [];
after(() => {
  for (const child of spawned) child.kill();
});

/** A live process with a chosen cwd and command line, for the prober to find. */
function keepalive(cwd: string, args: string[] = []): number {
  const script = path.join(os.tmpdir(), 'baton-keepalive.mjs');
  fs.writeFileSync(script, 'setTimeout(() => {}, 30_000);\n');
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'ignore' });
  spawned.push(child);
  const pid = child.pid!;

  // spawn returns before ps is guaranteed to show the exec'd command line.
  for (let i = 0; i < 100; i++) {
    const out = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (out.stdout?.includes('baton-keepalive.mjs')) return pid;
    sleepMs(20);
  }
  throw new Error(`spawned process ${pid} never appeared in ps`);
}

/** Every unknown says which kind of unknown it is; every known says where it came from. */
function assertHonest<T>(field: Field<T>, what: string): void {
  if (field.known) {
    assert.ok(field.source.length > 0, `${what} is known but does not say where it came from`);
  } else {
    assert.ok(
      ['unavailable', 'unsupported', 'not-recorded', 'not-applicable'].includes(field.reason),
      `${what} has an unrecognised reason "${field.reason}"`,
    );
    assert.ok(field.detail.length > 0, `${what} is unknown but does not say why`);
  }
}

/* ------------------------------------------------------------------ health */

test('an account directory with no identity is a draft, not a broken account', () => {
  sandbox();
  const [health] = accountHealth(provider, [account('fresh', { email: undefined })], {
    sessions: [],
    limits: [],
  });

  assert.equal(health!.status, 'draft');
  assert.match(health!.reason, /never signed in/i);
});

test('an identified account with a scanned store and no limit events is ok', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const [health] = accountHealth(provider, [account('work')], { sessions: [], limits: [] });
  assert.equal(health!.status, 'ok');
  assert.match(health!.reason, /no limit hit/i);
});

test('no pooled history to scan means unknown, never ok', () => {
  sandbox();
  const [health] = accountHealth(provider, [account('work')], { sessions: [], limits: [] });

  assert.equal(health!.status, 'unknown', 'nothing was scanned, so nothing was ruled out');
  assert.equal(health!.spent.known, false);
  assert.equal(health!.lastLimitAt.known, false);
  if (!health!.lastLimitAt.known) assert.equal(health!.lastLimitAt.reason, 'not-recorded');
});

test('a limit event attributed to an account marks it spent and keeps the provider wording', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const pid = keepalive(dir, [`--resume=${SESSION_ID}`]);
  assert.equal(recordObservation(provider, [session(pid, 'work')]), 1);

  const [health] = accountHealth(provider, [account('work')], {
    sessions: [session(pid, 'work')],
    limits: [limitEvent({ cwd: dir })],
  });

  assert.equal(health!.status, 'spent');
  assert.equal(health!.spent.known, true);
  if (health!.spent.known) {
    assert.equal(health!.spent.value.confidence, 'exact');
    assert.equal(health!.spent.value.resets.known, true);
    if (health!.spent.value.resets.known) {
      assert.equal(
        health!.spent.value.resets.value,
        '7:40pm (America/New_York)',
        'the reset time is passed through as the provider worded it, not reparsed',
      );
    }
  }
  assert.match(health!.reason, /7:40pm \(America\/New_York\)/);
});

test('a spent account outside the window is no longer spent', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const pid = keepalive(dir, [`--resume=${SESSION_ID}`]);
  recordObservation(provider, [session(pid, 'work')]);

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  const [health] = accountHealth(provider, [account('work')], {
    sessions: [],
    limits: [limitEvent({ cwd: dir, at: sixHoursAgo })],
  });

  assert.notEqual(health!.status, 'spent');
  assert.equal(health!.lastLimitAt.known, true, 'the event is still reported, it just no longer bites');
  assert.equal(health!.spent.known, false);
  if (!health!.spent.known) assert.equal(health!.spent.reason, 'not-applicable');
});

test('a limit nobody can be blamed for leaves every account unknown rather than ok', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const health = accountHealth(provider, [account('work'), account('personal')], {
    sessions: [],
    limits: [limitEvent({ sessionId: OTHER_SESSION_ID, cwd: '/nowhere/at/all' })],
  });

  for (const row of health) {
    assert.equal(row.status, 'unknown');
    assert.equal(row.unattributedLimits, 1);
    assert.match(row.reason, /does not record which account/i);
  }
});

test('a reset time for an account that is not spent is not-applicable, not unavailable', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const [health] = accountHealth(provider, [account('work')], { sessions: [], limits: [] });
  assert.equal(health!.spent.known, false);
  if (!health!.spent.known) {
    assert.equal(health!.spent.reason, 'not-applicable', 'the question does not apply; it is not unknowable');
  }
});

test('live sessions and bound editors come through per account', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const work = account('work');
  const [health] = accountHealth(provider, [work, account('personal')], {
    sessions: [session(1, 'work'), session(2, 'work'), session(3, 'personal')],
    limits: [],
    hosts: [
      { id: 'cursor', label: 'Cursor', configFile: '/c', configDir: work.configDir, inconsistent: false, providerId: 'claude' },
      { id: 'vscode', label: 'VS Code', configFile: '/v', configDir: '/elsewhere', inconsistent: false, providerId: 'claude' },
    ],
  });

  assert.equal(health!.liveSessions.known, true);
  if (health!.liveSessions.known) {
    assert.equal(health!.liveSessions.value.count, 2);
    assert.deepEqual(health!.liveSessions.value.editors, ['cursor']);
  }
  assert.deepEqual(health!.boundEditors, ['Cursor']);
});

test('lastUsedAt is unknown-because-not-recorded until a session has been watched', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  const before = accountHealth(provider, [account('work')], { sessions: [], limits: [] })[0]!;
  assert.equal(before.lastUsedAt.known, false);
  if (!before.lastUsedAt.known) {
    assert.equal(before.lastUsedAt.reason, 'not-recorded');
    assert.match(before.lastUsedAt.detail, /pooled/i);
  }

  const pid = keepalive(dir);
  recordObservation(provider, [session(pid, 'work')]);
  clearAttributionCache();

  const after = accountHealth(provider, [account('work')], { sessions: [], limits: [] })[0]!;
  assert.equal(after.lastUsedAt.known, true);
  if (after.lastUsedAt.known) assert.match(after.lastUsedAt.source, /observed running/i);
});

/* ------------------------------------------- the unavailable-field contract */

test('what cannot be known is listed with a reason, on every row', () => {
  sandbox();
  const ids = UNAVAILABLE_FIELDS.map((f) => f.field);
  for (const required of ['plan', 'creditBalance', 'renewalDate', 'usageAgainstLimit']) {
    assert.ok(ids.includes(required), `${required} must be declared unavailable, not silently omitted`);
  }
  for (const f of UNAVAILABLE_FIELDS) {
    assert.ok(f.label.length > 0 && f.why.length > 20, `${f.field} needs an explanation a user can read`);
  }
  assert.match(
    UNAVAILABLE_FIELDS.find((f) => f.field === 'usageAgainstLimit')!.why,
    /policy-limits\.json/,
    'the file that looks like usage but is not must be named, so nobody re-checks it',
  );

  const [health] = accountHealth(provider, [account('work')], { sessions: [], limits: [] });
  assert.deepEqual(health!.unavailable, UNAVAILABLE_FIELDS);
  assert.ok(!('plan' in health!), 'no estimated plan field is invented');
  assert.ok(!('credits' in health!), 'no estimated credit field is invented');
});

test('every field says either where it came from or which kind of unknown it is', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'shared', 'claude', 'projects'), { recursive: true });

  for (const row of accountHealth(provider, [account('work'), account('draft', { email: undefined })], {
    sessions: [session(1, 'work')],
    limits: [limitEvent({ sessionId: OTHER_SESSION_ID, cwd: '/nowhere' })],
  })) {
    assertHonest(row.spent, `${row.accountId}.spent`);
    assertHonest(row.lastLimitAt, `${row.accountId}.lastLimitAt`);
    assertHonest(row.liveSessions, `${row.accountId}.liveSessions`);
    assertHonest(row.lastUsedAt, `${row.accountId}.lastUsedAt`);
    if (row.spent.known) assertHonest(row.spent.value.resets, `${row.accountId}.spent.resets`);
    assert.ok(row.reason.length > 0);
  }
});

/* ------------------------------------------------------------- attribution */

test('a session that names itself round-trips by session id', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  const pid = keepalive(dir, [`--resume=${SESSION_ID}`]);

  assert.equal(recordObservation(provider, [session(pid, 'work')]), 1);
  clearAttributionCache();

  assert.equal(attributionFor(SESSION_ID), 'work');
  assert.equal(resolveAttribution(SESSION_ID)?.confidence, 'exact');

  const [record] = listAttributions();
  assert.equal(record!.sessionId, SESSION_ID);
  assert.equal(record!.cwd && fs.realpathSync(record!.cwd), fs.realpathSync(dir), 'cwd is read off the process');
  assert.ok(record!.startedAt && Number.isFinite(Date.parse(record!.startedAt)), 'start time parses');
});

test('a session that never names itself is matched by directory and time, and marked inferred', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  const pid = keepalive(dir);
  recordObservation(provider, [session(pid, 'work')]);
  clearAttributionCache();

  assert.equal(attributionFor(SESSION_ID), null, 'no exact answer is invented');

  const inferred = resolveAttribution(SESSION_ID, { cwd: dir, at: new Date().toISOString() });
  assert.equal(inferred?.accountId, 'work');
  assert.equal(inferred?.confidence, 'inferred');

  assert.equal(resolveAttribution(SESSION_ID, { cwd: '/somewhere/else', at: new Date().toISOString() }), null);
  assert.equal(
    resolveAttribution(SESSION_ID, { cwd: dir, at: new Date(Date.now() - 60 * 60_000).toISOString() }),
    null,
    'an hour before the session was seen is outside the window',
  );
});

test('two accounts in one directory is ambiguous, and answers null instead of guessing', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  const a = keepalive(dir);
  const b = keepalive(dir);

  recordObservation(provider, [session(a, 'work'), session(b, 'personal')]);
  clearAttributionCache();

  assert.equal(listAttributions().length, 2);
  assert.equal(resolveAttribution(null, { cwd: dir, at: new Date().toISOString() }), null);
});

test('observations of sessions with no resolvable account are skipped, not stored as unknown', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  sandbox();
  const pid = keepalive(os.tmpdir());
  assert.equal(recordObservation(provider, [{ ...session(pid, 'work'), accountId: null }]), 0);
  assert.equal(listAttributions().length, 0);
});

test('concurrent pollers all land in the file and none corrupts it', async (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();

  const moduleUrl = pathToFileURL(path.resolve('src/core/attribution.ts')).href;
  const script = path.join(dir, 'poller.mjs');
  fs.writeFileSync(
    script,
    `import { recordObservation } from ${JSON.stringify(moduleUrl)};
const provider = { id: 'claude', label: 'Claude', envVar: 'CLAUDE_CONFIG_DIR',
  sharePolicy: { shared: [], private: [], merged: [] },
  discoverAccounts: () => [], discoverHosts: () => [], bindHost: () => '' };
const s = { pid: process.pid, providerId: 'claude', configDir: null,
  accountId: process.argv[2], entrypoint: null, editorHint: null };
for (let i = 0; i < 3; i++) recordObservation(provider, [s]);
`,
  );

  const accounts = ['a', 'b', 'c', 'd', 'e', 'f'];
  await Promise.all(
    accounts.map(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [script, id], {
            env: { ...process.env, BATON_HOME: dir },
            stdio: 'ignore',
          });
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`poller ${id} exited ${code}`))));
        }),
    ),
  );

  const raw = fs.readFileSync(path.join(dir, 'attribution.json'), 'utf8');
  const parsed = JSON.parse(raw) as { records: Record<string, { accountId: string }> };
  const found = new Set(Object.values(parsed.records).map((r) => r.accountId));

  assert.deepEqual([...found].sort(), accounts, 'every poller survived; none overwrote another');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left behind');
});

test('the map stays bounded and reports that it dropped history', () => {
  const dir = sandbox();
  fs.mkdirSync(dir, { recursive: true });

  const base = Date.now();
  const stamp = (msAgo: number): string => new Date(base - msAgo).toISOString();
  const record = (id: string, at: string) => ({
    providerId: 'claude',
    accountId: 'work',
    sessionId: id,
    cwd: null,
    pid: 1,
    startedAt: null,
    editor: null,
    firstSeen: at,
    lastSeen: at,
  });

  const records: Record<string, unknown> = {};
  for (let i = 0; i < MAX_ATTRIBUTION_RECORDS + 200; i++) {
    records[`sid:s${i}`] = record(`s${i}`, stamp(i * 1000));
  }
  const ancientAt = stamp(100 * 24 * 60 * 60 * 1000);
  records['sid:ancient'] = record('ancient', ancientAt);

  fs.writeFileSync(
    path.join(dir, 'attribution.json'),
    JSON.stringify({ version: 1, since: ancientAt, truncated: false, records }),
  );
  clearAttributionCache();

  recordObservation(provider, [session(999_999, 'work')]);
  clearAttributionCache();

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'attribution.json'), 'utf8')) as {
    since: string;
    truncated: boolean;
    records: Record<string, unknown>;
  };

  assert.ok(Object.keys(after.records).length <= MAX_ATTRIBUTION_RECORDS, 'record count is capped');
  assert.equal(after.truncated, true);
  assert.equal(after.records['sid:ancient'], undefined, 'records past the age limit are dropped');
  assert.ok(
    Date.parse(after.since) > Date.parse(ancientAt),
    'since moves up to what is still held, so coverage is measured against a real window',
  );
});

test('a corrupt file loses its contents rather than throwing', () => {
  const dir = sandbox();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'attribution.json'), '{ this is not json');
  clearAttributionCache();

  assert.equal(attributionFor(SESSION_ID), null);
  assert.deepEqual(listAttributions(), []);
  assert.equal(recordObservation(provider, [session(999_998, 'work')]), 1);
});

test('coverage is measured against history recording could have caught', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  const dir = sandbox();
  const projects = path.join(dir, 'shared', 'claude', 'projects', '-tmp-proj');
  fs.mkdirSync(projects, { recursive: true });

  // A transcript that predates recording can never be attributed.
  fs.writeFileSync(path.join(projects, `${OTHER_SESSION_ID}.jsonl`), '{}\n');
  sleepMs(30);

  const pid = keepalive(dir, [`--resume=${SESSION_ID}`]);
  recordObservation(provider, [session(pid, 'work')]);
  sleepMs(30);
  fs.writeFileSync(path.join(projects, `${SESSION_ID}.jsonl`), '{}\n');
  clearAttributionCache();

  const stats = attributionStats([provider]);
  assert.equal(stats.recorded, 1);
  assert.ok(stats.since && Number.isFinite(Date.parse(stats.since)));
  assert.equal(stats.coverage.transcripts, 2);
  assert.equal(stats.coverage.inRange, 1, 'the older transcript is not held against coverage');
  assert.equal(stats.coverage.attributed, 1);
  assert.equal(stats.coverage.fraction, 1);
});

test('sessions observed without a session id are counted as such, not as coverage', (t) => {
  if (!POSIX) return t.skip('process probing is POSIX only');
  sandbox();
  const pid = keepalive(os.tmpdir());
  recordObservation(provider, [session(pid, 'work')]);
  clearAttributionCache();

  const stats = attributionStats([provider]);
  assert.equal(stats.recorded, 1);
  assert.equal(stats.coverage.observedOnly, 1, 'seen running, but not linkable to a transcript by id');
  assert.equal(stats.coverage.attributed, 0);
});
