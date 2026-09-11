import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflight, renderPreflight, formatBytes, binaryOnPath, REQUIRED_NODE } from '../src/core/preflight.ts';
import { accountDirFor } from '../src/core/setup.ts';
import type { Account, Host, Provider } from '../src/core/types.ts';

/** Keep every run inside a temp BATON_HOME so no real state is read. */
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-preflight-'));
  process.env.BATON_HOME = path.join(dir, 'home');
  return dir;
}

function stubProvider(over: Partial<Provider> = {}): Provider {
  return {
    id: 'stub',
    label: 'Stub Code',
    envVar: 'STUB_CONFIG_DIR',
    processName: 'stub',
    isInstalled: () => ({ installed: true, detail: 'CLI at /usr/local/bin/stub' }),
    sharePolicy: { shared: ['projects'], private: [], merged: [] },
    discoverAccounts: () => [],
    discoverHosts: () => [],
    bindHost: () => '',
    ...over,
  };
}

function stubAccount(dir: string, over: Partial<Account> = {}): Account {
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return {
    id: 'work',
    label: 'work',
    configDir: dir,
    email: 'someone@example.com',
    isDefault: false,
    providerId: 'stub',
    ...over,
  };
}

function stubHost(over: Partial<Host> = {}): Host {
  return {
    id: 'vscode',
    label: 'VS Code',
    configFile: '/tmp/settings.json',
    inconsistent: false,
    providerId: 'stub',
    extensionInstalled: true,
    extensionVersion: '1.2.3',
    ...over,
  };
}

const run = (provider: Provider) => preflight({ providers: [provider], skipSessions: true });

test('a machine with no provider installed is a blocker, not a crash', () => {
  sandbox();
  const report = run(stubProvider({ isInstalled: () => ({ installed: false, detail: 'nowhere' }) }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers.map((b) => b.code), ['no-provider']);
  assert.equal(report.installedProviders.length, 0);
});

test('no editors is advisory, and says terminal use still works', () => {
  sandbox();
  const report = run(stubProvider());
  assert.equal(report.ok, true, 'no editors must never block setup');
  const note = report.warnings.find((w) => w.code === 'no-editors');
  assert.ok(note, 'expected a no-editors warning');
  assert.match(note.action, /terminal/i);
});

test('a provider that never implements isInstalled is still walked', () => {
  sandbox();
  const report = run(stubProvider({ isInstalled: undefined }));
  assert.equal(report.installedProviders.length, 1);
  assert.equal(report.providers[0]!.via, 'unknown');
});

test('an account with no identity reads as a draft, with the login command', () => {
  const dir = sandbox();
  const account = stubAccount(path.join(dir, '.stub-work'), { email: undefined });
  const report = run(stubProvider({ discoverAccounts: () => [account] }));

  assert.equal(report.providers[0]!.accounts[0]!.draft, true);
  const draft = report.warnings.find((w) => w.code === 'draft-account');
  assert.ok(draft);
  assert.match(draft.command ?? '', /STUB_CONFIG_DIR=/);
});

test('one account is flagged as nothing to switch between', () => {
  const dir = sandbox();
  const report = run(stubProvider({ discoverAccounts: () => [stubAccount(path.join(dir, '.stub-work'))] }));
  assert.ok(report.warnings.some((w) => w.code === 'single-account'));
});

test('unpooled history is reported per provider once there are two accounts', () => {
  const dir = sandbox();
  const accounts = [
    stubAccount(path.join(dir, '.stub-a'), { id: 'a' }),
    stubAccount(path.join(dir, '.stub-b'), { id: 'b' }),
  ];
  const report = run(stubProvider({ discoverAccounts: () => accounts }));

  assert.equal(report.providers[0]!.history.state, 'none');
  assert.ok(report.warnings.some((w) => w.code === 'history-not-pooled'));
});

test('an entry symlinked into the store counts as pooled', () => {
  const dir = sandbox();
  const account = stubAccount(path.join(dir, '.stub-work'));
  const store = path.join(process.env.BATON_HOME!, 'shared', 'stub', 'projects');
  fs.mkdirSync(store, { recursive: true });
  fs.rmSync(path.join(account.configDir, 'projects'), { recursive: true });
  fs.symlinkSync(store, path.join(account.configDir, 'projects'));

  const report = run(stubProvider({ discoverAccounts: () => [account] }));
  assert.equal(report.providers[0]!.accounts[0]!.pooling.state, 'full');
  assert.equal(report.providers[0]!.history.state, 'pooled');
});

test('host problems carry the command that fixes them', () => {
  sandbox();
  const hosts = [
    stubHost({ id: 'cursor', label: 'Cursor', inconsistent: true }),
    stubHost({ id: 'vscode', configDir: '/nowhere/.stub-gone' }),
    stubHost({ id: 'trae', label: 'Trae', extensionInstalled: false }),
  ];
  const report = run(stubProvider({ discoverHosts: () => hosts }));
  const codes = report.warnings.map((w) => w.code);

  assert.ok(codes.includes('host-inconsistent'));
  assert.ok(codes.includes('host-unknown-dir'));
  assert.ok(codes.includes('extension-missing'));
  assert.match(report.warnings.find((w) => w.code === 'host-inconsistent')!.command ?? '', /--host cursor/);
});

test('the node check compares against the engines requirement', () => {
  sandbox();
  const report = run(stubProvider());
  assert.equal(report.node.required, REQUIRED_NODE);
  assert.equal(report.node.version, process.versions.node);
  assert.equal(report.node.ok, true, 'the test runner itself satisfies the requirement');
});

test('rendering is plain text when colour is off', () => {
  sandbox();
  const lines = renderPreflight(run(stubProvider()), { color: false });
  assert.ok(lines.some((l) => l.includes('Stub Code')));
  assert.ok(!lines.join('\n').includes('\x1b['), 'no escape codes when colour is off');
});

test('formatBytes stays readable at every scale', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(2048), '2.0KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0MB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20MB');
});

test('binaryOnPath returns null rather than throwing for a missing binary', () => {
  assert.equal(binaryOnPath('definitely-not-a-real-binary-xyz'), null);
});

test('account directories are named per provider and sanitised', () => {
  assert.equal(path.basename(accountDirFor('work')), '.claude-work');
  assert.equal(path.basename(accountDirFor('claude-work')), '.claude-work');
  assert.equal(path.basename(accountDirFor('testing new')), '.claude-testing-new');
  assert.equal(path.basename(accountDirFor('work', 'stub')), '.stub-work');
});
