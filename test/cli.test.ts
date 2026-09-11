import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Drive the CLI as a user does.
 *
 * The commands that WRITE had no coverage, and every bug found in the last
 * review was living in one: the shell wrapper evaluating `use` output, the
 * completions calling a flag that did not exist, editor binding writing
 * unrestorable backups, `preflight` printing a JavaScript array. None of those
 * are reachable by unit-testing a module — they only appear when the command
 * actually runs.
 *
 * Each test gets its own HOME, so nothing here can touch the real machine.
 */
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-cli-'));
});

function makeAccount(name: string, opts: { email?: string; project?: string } = {}): string {
  const dir = path.join(home, name === 'default' ? '.claude' : `.claude-${name}`);
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const jsonPath = name === 'default' ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      oauthAccount: opts.email ? { emailAddress: opts.email } : undefined,
      projects: {},
    }),
    'utf8',
  );
  if (opts.project) {
    const pdir = path.join(dir, 'projects', opts.project);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(
      path.join(pdir, `${name}-session.jsonl`),
      JSON.stringify({ type: 'user', timestamp: '2026-09-01T00:00:00.000Z', cwd: `/w/${opts.project}', message: {}` }),
      'utf8',
    );
  }
  return dir;
}

function run(args: string[], opts: { expectFail?: boolean } = {}): { out: string; json: any; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, BATON_HOME: path.join(home, '.baton'), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let json = null;
    try { json = JSON.parse(out); } catch { /* human output */ }
    return { out, json, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    const out = err.stdout ?? '';
    let json = null;
    try { json = JSON.parse(out); } catch { /* not json */ }
    if (!opts.expectFail) assert.fail(`command failed: baton ${args.join(' ')}\n${out}`);
    return { out, json, code: err.status ?? 1 };
  }
}

test('discovers accounts in an isolated home', () => {
  makeAccount('default', { email: 'a@x.com' });
  makeAccount('work', { email: 'b@x.com' });
  const { json } = run(['accounts', '--json']);
  assert.deepEqual(json.accounts.map((a: any) => a.accountId).sort(), ['default', 'work']);
});

test('a never-logged-in account is a draft with its OWN login command', () => {
  makeAccount('one', { email: 'a@x.com' });
  makeAccount('blank');
  const { json } = run(['accounts', '--json']);
  const draft = json.accounts.find((a: any) => a.accountId === 'blank');
  assert.equal(draft.state, 'draft');
  assert.match(draft.loginCommand, /\.claude-blank/, 'names its own directory, not a generic /login');
  const other = json.accounts.find((a: any) => a.accountId === 'one');
  assert.notEqual(draft.loginCommand, other.reauth.command, 'two accounts never share one command');
});

test('accounts --ids prints bare ids, as the completions need', () => {
  makeAccount('one', { email: 'a@x.com' });
  makeAccount('two', { email: 'b@x.com' });
  const { out } = run(['accounts', '--ids']);
  assert.deepEqual(out.trim().split('\n').sort(), ['one', 'two']);
});

test('link pools history into one snapshot, not one per entry', () => {
  makeAccount('one', { email: 'a@x.com', project: 'alpha' });
  makeAccount('two', { email: 'b@x.com', project: 'beta' });

  run(['link', '--all', '--json']);

  const store = path.join(home, '.baton', 'shared', 'claude', 'projects');
  assert.deepEqual(fs.readdirSync(store).sort(), ['alpha', 'beta'], 'both projects survive');

  const snaps = fs.readdirSync(path.join(home, '.baton', 'backups'));
  assert.equal(snaps.length, 1, `expected one snapshot for one operation, got ${snaps.length}`);
  assert.ok(fs.existsSync(path.join(home, '.baton', 'backups', snaps[0]!, 'manifest.json')));
});

test('a dry run writes nothing at all', () => {
  makeAccount('one', { email: 'a@x.com', project: 'alpha' });
  run(['link', '--all', '--dry-run', '--json']);
  assert.equal(fs.existsSync(path.join(home, '.baton', 'shared')), false);
  assert.equal(fs.existsSync(path.join(home, '.baton', 'backups')), false);
});

test('remove keeps conversation history and never touches the store', () => {
  makeAccount('one', { email: 'a@x.com', project: 'alpha' });
  makeAccount('two', { email: 'b@x.com', project: 'beta' });
  run(['link', '--all', '--json']);

  const store = path.join(home, '.baton', 'shared', 'claude', 'projects');
  const before = fs.readdirSync(store).sort();

  const { json } = run(['remove', 'two', '--json']);
  assert.equal(json.history, 'keep');
  assert.equal(fs.existsSync(path.join(home, '.claude-two')), false, 'the account directory is gone');
  assert.deepEqual(fs.readdirSync(store).sort(), before, 'the shared store is untouched');
  assert.equal(
    json.removed.filter((r: any) => r.path.startsWith(json.sharedStore)).length,
    0,
    'nothing inside the store was ever a removal target',
  );
});

test('backups prune honours the ceiling and keeps the newest', () => {
  makeAccount('one', { email: 'a@x.com', project: 'alpha' });
  makeAccount('two', { email: 'b@x.com', project: 'beta' });
  run(['link', '--all', '--json']);

  // Each switch rewrites .claude.json for the target, which is a real backup.
  // Repeating `link` would not: an already-linked account copies nothing, and
  // an empty snapshot removes its own directory.
  for (let i = 0; i < 6; i++) {
    run(['use', i % 2 ? 'one' : 'two', '--host', 'nonexistent', '--json'], { expectFail: true });
    run(['link', 'one', '--json']);
    run(['link', 'two', '--json']);
  }

  run(['settings', 'set', 'backups.maxCount', '2', '--json']);
  run(['backups', 'prune', '--json']);

  const { json: after } = run(['backups', '--json']);
  assert.ok(after.stats.count <= 2, `expected <= 2 snapshots, got ${after.stats.count}`);
  assert.ok(after.stats.count >= 1, 'never leave nothing to restore from');
});

test('settings round-trip through the CLI', () => {
  makeAccount('one', { email: 'a@x.com' });
  run(['settings', 'set', 'autoSwitch.mode', 'switch', '--json']);
  const { json } = run(['settings', '--json']);
  assert.equal(json.settings.autoSwitch.mode, 'switch');
  assert.equal(json.settings.autoSwitch.enabled, false, 'an untouched sibling survives');
});

test('alias changes the display name and nothing on disk', () => {
  const dir = makeAccount('one', { email: 'a@x.com' });
  run(['alias', 'one', 'Work', '--json']);
  const { json } = run(['accounts', '--json']);
  assert.equal(json.accounts[0].displayName, 'Work');
  assert.equal(json.accounts[0].accountId, 'one', 'the real id is unchanged');
  assert.ok(fs.existsSync(dir), 'the directory did not move');
});

test('env emits a sourceable script quoting a path with a space', () => {
  fs.mkdirSync(path.join(home, '.claude-odd name', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude-odd name', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }),
    'utf8',
  );
  const { out } = run(['env', 'odd name', '--shell', 'bash']);
  assert.match(out, /export CLAUDE_CONFIG_DIR='.*\.claude-odd name'/);
});

test('preflight prints text, not a JavaScript array', () => {
  makeAccount('one', { email: 'a@x.com' });
  const { out } = run(['preflight']);
  assert.ok(!out.trimStart().startsWith('['), `printed an array literal: ${out.slice(0, 60)}`);
  assert.match(out, /This machine/);
});

test('uninstall refuses without --yes, then restores standalone files', () => {
  makeAccount('one', { email: 'a@x.com', project: 'alpha' });
  run(['link', '--all', '--json']);
  assert.ok(fs.lstatSync(path.join(home, '.claude-one', 'projects')).isSymbolicLink());

  const refused = run(['uninstall', '--json'], { expectFail: true });
  assert.equal(refused.code, 1, 'refuses without --yes');

  run(['uninstall', '--yes', '--json']);
  assert.equal(
    fs.lstatSync(path.join(home, '.claude-one', 'projects')).isSymbolicLink(),
    false,
    'the account holds its own files again',
  );
  assert.ok(fs.existsSync(path.join(home, '.claude-one', 'projects', 'alpha')), 'history came back');
});

test('an unknown account fails with a useful message, not a stack trace', () => {
  makeAccount('one', { email: 'a@x.com' });
  const { json, code } = run(['use', 'nope', '--json'], { expectFail: true });
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.match(json.error, /nope/);
  assert.match(json.error, /one/, 'names what does exist');
});
