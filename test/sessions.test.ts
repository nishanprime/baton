import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLiveSessions, editorFromPath } from '../src/core/sessions.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

test('an extension-hosted binary names its editor', () => {
  assert.equal(
    editorFromPath('/Users/x/.cursor/extensions/anthropic.claude-code-2.1.0/resources/claude'),
    'cursor',
  );
  assert.equal(
    editorFromPath('/Users/x/.vscode/extensions/anthropic.claude-code-2.1.0/bin/claude'),
    'vscode',
  );
});

test('the -ide suffix is dropped so the name matches the editor id', () => {
  assert.equal(
    editorFromPath('/Users/x/.antigravity-ide/extensions/anthropic.claude-code-2.1.0/claude'),
    'antigravity',
  );
});

test('an app bundle names its editor', () => {
  assert.equal(editorFromPath('/Applications/Cursor.app/Contents/MacOS/claude'), 'Cursor');
});

test('a Windows install path names its editor', () => {
  assert.equal(
    editorFromPath('C:\\Users\\x\\AppData\\Local\\Programs\\Cursor\\resources\\claude.exe'),
    'Cursor',
  );
});

test('a plain binary has no editor rather than a wrong one', () => {
  assert.equal(editorFromPath('/usr/local/bin/claude'), null);
  assert.equal(editorFromPath('/opt/homebrew/bin/claude'), null);
});

test('no providers means no sessions, without shelling out', () => {
  assert.deepEqual(findLiveSessions([], []), []);
});

test('scanning the real process table returns well-formed rows', () => {
  // Cannot assert a count — it depends on what is running — but every row that
  // comes back must be shaped correctly, since the UI renders these directly.
  const sessions = findLiveSessions([claudeProvider], claudeProvider.discoverAccounts());
  assert.ok(Array.isArray(sessions));
  for (const s of sessions) {
    assert.equal(typeof s.pid, 'number');
    assert.ok(s.pid > 0, 'a pid of zero would be a parse failure');
    assert.equal(s.providerId, 'claude');
    assert.ok(s.configDir === null || typeof s.configDir === 'string');
    assert.ok(s.accountId === null || typeof s.accountId === 'string');
  }
});

test('Baton never reports itself as a session of the thing it manages', () => {
  const sessions = findLiveSessions([claudeProvider], claudeProvider.discoverAccounts());
  assert.equal(
    sessions.some((s) => s.pid === process.pid),
    false,
  );
});
