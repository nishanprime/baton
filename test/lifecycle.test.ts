import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyAccount,
  reauthCommand,
  removeAccount,
  canRemoveAccount,
  renameAccount,
  LifecycleError,
} from '../src/core/lifecycle.ts';
import { clearAttributionCache } from '../src/core/attribution.ts';
import { linkAccount } from '../src/core/share.ts';
import { sharedStore } from '../src/core/paths.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import type { Account, Host } from '../src/core/types.ts';
import type { LiveSession } from '../src/core/sessions.ts';
import type { LimitEvent } from '../src/core/limits.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-lifecycle-'));
  process.env.BATON_HOME = path.join(root, '.baton');
});

function account(
  dirName: string,
  opts: { email?: string; files?: Record<string, string> } = {},
): Account {
  const configDir = path.join(root, dirName);
  fs.mkdirSync(configDir, { recursive: true });
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    const f = path.join(configDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf8');
  }
  return {
    id: dirName.replace(/^\.claude-?/, ''),
    label: dirName,
    configDir,
    email: opts.email,
    isDefault: false,
    providerId: 'claude',
  };
}

function host(id: string, configDir?: string): Host {
  return {
    id,
    label: id === 'cursor' ? 'Cursor' : 'VS Code',
    configFile: path.join(root, 'editors', id, 'settings.json'),
    configDir,
    inconsistent: false,
    providerId: 'claude',
  };
}

function session(a: Account, pid = 4242): LiveSession {
  return {
    pid,
    providerId: 'claude',
    configDir: a.configDir,
    accountId: a.id,
    entrypoint: 'cli',
    editorHint: 'cursor',
  };
}

function limitEvent(at: string): LimitEvent {
  return {
    providerId: 'claude',
    sessionId: 'abc',
    project: 'repo',
    cwd: '/work/repo',
    at,
    resets: '4:10am (America/New_York)',
    message: "You've hit your session limit · resets 4:10am (America/New_York)",
  };
}

/** Every path under a dir with its content, so two trees can be compared exactly. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(full)}`;
      else if (e.isDirectory()) walk(full, key);
      else out[key] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

const storeTree = () => tree(sharedStore('claude'));

// ---------------------------------------------------------------- state

test('a directory nothing ever logged into is a draft, with the login command attached', () => {
  // Matches the real ~/.claude-test: the CLI writes userID and machineID on its
  // very first start, so neither of them means anyone logged in.
  const a = account('.claude-test', {
    files: { '.claude.json': JSON.stringify({ userID: 'u', machineID: 'm' }) },
  });

  const status = classifyAccount(claudeProvider, a, [], { hosts: [] });

  assert.equal(status.state, 'draft');
  assert.ok(status.loginCommand, 'a draft must say how to fix itself');
  assert.match(status.loginCommand!, /CLAUDE_CONFIG_DIR=/);
  assert.ok(status.loginCommand!.includes(a.configDir), 'the command names the exact dir');
  assert.match(status.nextAction, /Log in/);
});

test('a credentials file counts as an identity even with no email on disk', () => {
  const a = account('.claude-keyless', { files: { '.credentials.json': '{}' } });
  assert.equal(classifyAccount(claudeProvider, a, [], { hosts: [] }).state, 'idle');
});

test('logged in and bound to nothing is idle, not "unused"', () => {
  const a = account('.claude-spare', { email: 'spare@example.com' });
  const status = classifyAccount(claudeProvider, a, [], { hosts: [host('cursor', '/elsewhere')] });

  assert.equal(status.state, 'idle');
  assert.match(status.nextAction, /baton use spare/);
  assert.equal(status.loginCommand, null);
});

test('logged in and bound to an editor is active', () => {
  const a = account('.claude-work', { email: 'work@example.com' });
  const status = classifyAccount(claudeProvider, a, [], { hosts: [host('cursor', a.configDir)] });

  assert.equal(status.state, 'active');
  assert.deepEqual(status.boundHosts.map((h) => h.id), ['cursor']);
  assert.match(status.reason, /Cursor/);
});

test('a live session alone makes an account active', () => {
  const a = account('.claude-work', { email: 'work@example.com' });
  const status = classifyAccount(claudeProvider, a, [session(a)], { hosts: [] });

  assert.equal(status.state, 'active');
  assert.deepEqual(status.liveSessions.map((s) => s.pid), [4242]);
});

test('a limit event is only spent for the account attribution ties it to', () => {
  const a = account('.claude-work', { email: 'work@example.com' });
  const now = Date.parse('2026-09-11T22:00:00.000Z');
  const opts = {
    hosts: [host('cursor', a.configDir)],
    limits: [limitEvent('2026-09-11T21:50:00.000Z')],
    now,
  };

  // Nothing recorded whose session 'abc' was, so being the bound account is not
  // evidence. Blaming the bound account is precisely the bug this replaced: it
  // reported the account the user had just switched TO as spent, and the one
  // that actually ran out as ready.
  const unknown = classifyAccount(claudeProvider, a, [], opts);
  assert.equal(unknown.state, 'active', 'bound, but not shown to be the one that ran out');
  assert.equal(unknown.unattributedLimits, 1, 'the event is surfaced, just not pinned on anyone');

  // With an observation covering it, the same event does make the account spent.
  writeAttribution({
    sessionId: 'abc',
    accountId: 'work',
    firstSeen: '2026-09-11T21:00:00.000Z',
    lastSeen: '2026-09-11T21:55:00.000Z',
  });
  const attributed = classifyAccount(claudeProvider, a, [], opts);
  assert.equal(attributed.state, 'spent');
  assert.match(attributed.reason, /10 min ago/);
  assert.match(attributed.reason, /4:10am/);
  assert.equal(attributed.limit?.sessionId, 'abc');

  // Stale events do not keep an account marked spent forever.
  const old = classifyAccount(claudeProvider, a, [], {
    ...opts,
    limits: [limitEvent('2026-09-11T10:00:00.000Z')],
  });
  assert.equal(old.state, 'active');
});

/** Seed the attribution map with one observed window. */
function writeAttribution(r: {
  sessionId: string;
  accountId: string;
  firstSeen: string;
  lastSeen: string;
}): void {
  const dir = process.env.BATON_HOME!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'attribution.json'),
    JSON.stringify({
      version: 1,
      since: r.firstSeen,
      records: {
        [`sid:${r.sessionId}`]: {
          providerId: 'claude',
          accountId: r.accountId,
          sessionId: r.sessionId,
          cwd: null,
          pid: 1,
          startedAt: r.firstSeen,
          editor: null,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
        },
      },
    }),
    'utf8',
  );
  clearAttributionCache();
}

test('the login command survives a directory name with a space in it', () => {
  const a = account('.claude-testing new', { email: 'x@example.com' });
  const { command, explanation } = reauthCommand(claudeProvider, a);

  assert.ok(command.includes(`'${a.configDir}'`), `single-quoted path: ${command}`);
  assert.match(explanation, /\/login/);
  assert.ok(!/credential/i.test(command), 'the command never carries a secret');
});

// ---------------------------------------------------------------- delete

test('delete refuses while a session is live, and names the pid', () => {
  const a = account('.claude-work', { email: 'work@example.com' });
  const live = [session(a, 991)];

  const check = canRemoveAccount(claudeProvider, a, { liveSessions: live });
  assert.equal(check.ok, false);
  assert.match(check.refusals[0]!.message, /pid 991/);

  assert.throws(
    () => removeAccount(claudeProvider, a, { liveSessions: live, hosts: [] }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'live-sessions',
  );
  assert.ok(fs.existsSync(a.configDir), 'a refused delete removes nothing');

  const forced = removeAccount(claudeProvider, a, { liveSessions: live, hosts: [], force: true });
  assert.equal(forced.directoryRemoved, true);
  assert.ok(forced.warnings.some((w) => /forced past/.test(w)));
});

test('history "keep" leaves the shared store byte-identical', () => {
  const a = account('.claude-work', {
    email: 'work@example.com',
    files: { 'projects/repo/session.jsonl': 'conversation one\n', 'settings.json': '{}' },
  });
  const other = account('.claude-keep', {
    email: 'keep@example.com',
    files: { 'projects/other/session.jsonl': 'conversation two\n' },
  });
  linkAccount(claudeProvider, a);
  linkAccount(claudeProvider, other);

  const before = storeTree();
  assert.ok(Object.keys(before).length >= 2, 'store actually holds both histories');

  const result = removeAccount(claudeProvider, a, { liveSessions: [], hosts: [] });

  assert.deepEqual(storeTree(), before, 'the shared store is untouched');
  assert.ok(result.unlinkedShared.includes('projects'), 'the link was detached, not followed');
  assert.equal(result.directoryRemoved, true);
  assert.ok(!fs.existsSync(a.configDir));
  assert.equal(
    fs.readFileSync(path.join(other.configDir, 'projects/repo/session.jsonl'), 'utf8'),
    'conversation one\n',
    'the removed account\'s conversations are still readable from the other account',
  );
  // The symlink is counted as freeing nothing, so the report cannot claim the
  // whole pooled history as reclaimed space.
  assert.equal(result.removed.find((r) => r.kind === 'symlink')?.bytes, 0);
});

test('history that was never pooled is copied out before the directory goes', () => {
  const a = account('.claude-solo', {
    email: 'solo@example.com',
    files: { 'projects/repo/session.jsonl': 'never pooled\n' },
  });

  const result = removeAccount(claudeProvider, a, { liveSessions: [], hosts: [] });
  const kept = result.preserved.find((p) => p.path.endsWith('projects'));

  assert.ok(kept?.copiedTo, 'unpooled history is reported as preserved somewhere');
  assert.equal(
    fs.readFileSync(path.join(kept!.copiedTo!, 'repo/session.jsonl'), 'utf8'),
    'never pooled\n',
  );
  assert.ok(result.bytesFreed > 0);
});

test('with no snapshot to copy into, unpooled history is left in place instead', () => {
  const a = account('.claude-solo', {
    email: 'solo@example.com',
    files: { 'projects/repo/session.jsonl': 'never pooled\n', 'cache/x': 'junk' },
  });

  const result = removeAccount(claudeProvider, a, { liveSessions: [], hosts: [], backup: false });

  assert.equal(result.directoryRemoved, false);
  assert.ok(fs.existsSync(path.join(a.configDir, 'projects/repo/session.jsonl')));
  assert.ok(!fs.existsSync(path.join(a.configDir, 'cache')), 'private files still went');
  assert.ok(result.warnings.some((w) => /baton link solo/.test(w)));
});

test('history "delete" removes the account directory and still not the store', () => {
  const a = account('.claude-work', {
    email: 'work@example.com',
    files: { 'projects/repo/session.jsonl': 'conversation one\n' },
  });
  linkAccount(claudeProvider, a);
  const before = storeTree();

  const result = removeAccount(claudeProvider, a, {
    liveSessions: [],
    hosts: [],
    history: 'delete',
  });

  assert.equal(result.history, 'delete');
  assert.equal(result.directoryRemoved, true);
  assert.deepEqual(storeTree(), before, 'even an explicit delete cannot reach the store');
});

test('a dry run writes nothing at all', () => {
  const a = account('.claude-work', {
    email: 'work@example.com',
    files: { 'projects/repo/session.jsonl': 'x', 'settings.json': '{}' },
  });
  linkAccount(claudeProvider, a);

  const beforeAccount = tree(a.configDir);
  const beforeBaton = tree(process.env.BATON_HOME!);

  const result = removeAccount(claudeProvider, a, { liveSessions: [], hosts: [], dryRun: true });

  assert.equal(result.dryRun, true);
  assert.ok(result.removed.length > 0, 'it still reports what it would remove');
  assert.equal(result.backupPath, null);
  assert.deepEqual(tree(a.configDir), beforeAccount, 'account dir unchanged');
  assert.deepEqual(tree(process.env.BATON_HOME!), beforeBaton, 'no snapshot, no store change');
});

test('a config dir with a space in its name deletes cleanly', () => {
  const a = account('.claude-testing new', {
    email: 'space@example.com',
    files: { 'projects/repo/s.jsonl': 'x', 'settings.json': '{"theme":"auto"}' },
  });
  linkAccount(claudeProvider, a);
  const before = storeTree();

  const result = removeAccount(claudeProvider, a, { liveSessions: [], hosts: [host('cursor', a.configDir)] });

  assert.equal(result.directoryRemoved, true);
  assert.ok(!fs.existsSync(a.configDir));
  assert.deepEqual(storeTree(), before);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath), 'snapshot dir name is usable');
  assert.deepEqual(result.rebind.map((h) => h.id), ['cursor'], 'the editor pointing at it is reported');
});

test('the shared store can never be the target of a removal', () => {
  const store = sharedStore('claude');
  fs.mkdirSync(path.join(store, 'projects', 'repo'), { recursive: true });
  fs.writeFileSync(path.join(store, 'projects/repo/s.jsonl'), 'everyone\'s history\n');

  // Pointed straight at the store.
  const impostor: Account = {
    id: 'impostor',
    label: 'impostor',
    configDir: store,
    isDefault: false,
    providerId: 'claude',
  };
  assert.throws(
    () => removeAccount(claudeProvider, impostor, { liveSessions: [], hosts: [], force: true }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'shared-store',
  );

  // Pointed at a parent of the store.
  const swallower: Account = { ...impostor, configDir: path.dirname(path.dirname(store)) };
  assert.throws(
    () => removeAccount(claudeProvider, swallower, { liveSessions: [], hosts: [], force: true }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'shared-store',
  );

  assert.equal(
    fs.readFileSync(path.join(store, 'projects/repo/s.jsonl'), 'utf8'),
    'everyone\'s history\n',
  );
});

test('the home directory is not removable however it is dressed up', () => {
  const a: Account = {
    id: 'home',
    label: 'home',
    configDir: os.homedir(),
    isDefault: false,
    providerId: 'claude',
  };
  assert.throws(
    () => removeAccount(claudeProvider, a, { liveSessions: [], hosts: [], force: true }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'unsafe-path',
  );
});

// ---------------------------------------------------------------- rename

test('rename without confirm is a preflight: it reports consequences and moves nothing', () => {
  const a = account('.claude-testing new', {
    email: 'x@example.com',
    files: { 'projects/repo/s.jsonl': 'x' },
  });
  linkAccount(claudeProvider, a);

  const plan = renameAccount(claudeProvider, a, 'testing', {
    liveSessions: [],
    hosts: [host('cursor', a.configDir)],
  });

  assert.equal(plan.moved, false);
  assert.ok(fs.existsSync(a.configDir), 'nothing moved');
  assert.equal(plan.toDir, path.join(root, '.claude-testing'));
  assert.deepEqual(plan.rebind.map((h) => h.id), ['cursor']);
  assert.ok(plan.consequences.some((c) => c.kind === 'host' && c.file?.includes('cursor')));
  assert.ok(
    plan.consequences.some((c) => c.kind === 'link' && /absolute/.test(c.detail)),
    'it says why the shared-history links survive the move',
  );
});

test('rename with confirm moves the directory and keeps history reachable', () => {
  const a = account('.claude-old', {
    email: 'x@example.com',
    files: { 'projects/repo/s.jsonl': 'still here\n' },
  });
  linkAccount(claudeProvider, a);

  const plan = renameAccount(claudeProvider, a, 'new', { confirm: true, liveSessions: [], hosts: [] });

  assert.equal(plan.moved, true);
  assert.ok(!fs.existsSync(a.configDir));
  assert.equal(
    fs.readFileSync(path.join(plan.toDir, 'projects/repo/s.jsonl'), 'utf8'),
    'still here\n',
    'the absolute link into the store still resolves from the new path',
  );
});

test('rename refuses a live session, a name that is already taken, and a bad name', () => {
  const a = account('.claude-old', { email: 'x@example.com' });
  account('.claude-taken', { email: 'y@example.com' });

  assert.throws(
    () => renameAccount(claudeProvider, a, 'new', { confirm: true, liveSessions: [session(a)], hosts: [] }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'live-sessions',
  );
  assert.throws(
    () => renameAccount(claudeProvider, a, 'taken', { confirm: true, liveSessions: [], hosts: [] }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'target-exists',
  );
  assert.throws(
    () => renameAccount(claudeProvider, a, '../escape', { confirm: true, liveSessions: [], hosts: [] }),
    (err: unknown) => err instanceof LifecycleError && err.code === 'invalid-name',
  );
  assert.ok(fs.existsSync(a.configDir));
});
