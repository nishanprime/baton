import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkAccount, captureMerged, applyMerged } from '../src/core/share.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';
import type { Account } from '../src/core/types.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-share-'));
  process.env.BATON_HOME = path.join(root, '.baton');
});

function account(name: string, files: Record<string, string> = {}): Account {
  const configDir = path.join(root, name);
  fs.mkdirSync(configDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(configDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf8');
  }
  return { id: name, label: name, configDir, isDefault: false, providerId: 'claude' };
}

test('history from two accounts ends up in one store, nothing lost', () => {
  const a = account('.claude-one', { 'projects/proj-a/session1.jsonl': 'A1' });
  const b = account('.claude-two', { 'projects/proj-b/session2.jsonl': 'B2' });

  linkAccount(claudeProvider, a);
  linkAccount(claudeProvider, b);

  const store = path.join(process.env.BATON_HOME!, 'shared', 'claude', 'projects');
  assert.equal(fs.readFileSync(path.join(store, 'proj-a/session1.jsonl'), 'utf8'), 'A1');
  assert.equal(fs.readFileSync(path.join(store, 'proj-b/session2.jsonl'), 'utf8'), 'B2');

  // Both accounts now see the union through their symlink.
  for (const acct of [a, b]) {
    const p = path.join(acct.configDir, 'projects');
    assert.ok(fs.lstatSync(p).isSymbolicLink(), `${acct.id} projects is a symlink`);
    assert.deepEqual(fs.readdirSync(p).sort(), ['proj-a', 'proj-b']);
  }
});

test('linking is idempotent', () => {
  const a = account('.claude-one', { 'projects/p/s.jsonl': 'X' });
  linkAccount(claudeProvider, a);
  const second = linkAccount(claudeProvider, a);
  assert.ok(second.some((r) => r.entry === 'projects' && r.action === 'already-linked'));
  assert.equal(
    fs.readFileSync(path.join(a.configDir, 'projects/p/s.jsonl'), 'utf8'),
    'X',
    'history still readable after a repeat link',
  );
});

test('switching carries project state but never identity', () => {
  const from = account('.claude-one');
  const to = account('.claude-two');

  fs.writeFileSync(
    path.join(from.configDir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'one@example.com', accountUuid: 'UUID-ONE' },
      userID: 'user-one',
      projects: { '/work/repo': { allowedTools: ['Bash'] } },
    }),
  );
  fs.writeFileSync(
    path.join(to.configDir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'two@example.com', accountUuid: 'UUID-TWO' },
      userID: 'user-two',
      projects: {},
    }),
  );

  captureMerged(claudeProvider, from);
  applyMerged(claudeProvider, to);

  const result = JSON.parse(fs.readFileSync(path.join(to.configDir, '.claude.json'), 'utf8'));

  // Portable state crossed over...
  assert.deepEqual(result.projects['/work/repo'], { allowedTools: ['Bash'] });
  // ...and identity did not.
  assert.equal(result.oauthAccount.emailAddress, 'two@example.com');
  assert.equal(result.oauthAccount.accountUuid, 'UUID-TWO');
  assert.equal(result.userID, 'user-two');
});

test('unrecognised keys are treated as private, not shared', () => {
  const from = account('.claude-one');
  const to = account('.claude-two');
  fs.writeFileSync(
    path.join(from.configDir, '.claude.json'),
    JSON.stringify({ someFutureSecretKey: 'LEAK', projects: {} }),
  );
  fs.writeFileSync(path.join(to.configDir, '.claude.json'), JSON.stringify({ projects: {} }));

  captureMerged(claudeProvider, from);
  applyMerged(claudeProvider, to);

  const result = JSON.parse(fs.readFileSync(path.join(to.configDir, '.claude.json'), 'utf8'));
  assert.ok(!('someFutureSecretKey' in result), 'default-deny: unknown keys never cross accounts');
});

test('credentials and rate-limit state are never in the shared set', () => {
  const { shared, private: priv } = claudeProvider.sharePolicy;
  for (const secret of ['.credentials.json', 'policy-limits.json', 'remote-settings.json']) {
    assert.ok(!shared.includes(secret), `${secret} must not be shared`);
    assert.ok(priv.includes(secret), `${secret} must be explicitly private`);
  }
});

test('dry run leaves the filesystem untouched', () => {
  const a = account('.claude-one', { 'projects/p/s.jsonl': 'X' });
  linkAccount(claudeProvider, a, { dryRun: true });
  assert.ok(!fs.existsSync(process.env.BATON_HOME!), 'no store created');
  assert.ok(fs.statSync(path.join(a.configDir, 'projects')).isDirectory(), 'still a real dir');
});
