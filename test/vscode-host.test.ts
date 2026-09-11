import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindVsCodeHost, terminalEnvKey, type VsCodeBinding } from '../src/core/vscode-host.ts';
import { readJsonc } from '../src/core/jsonc.ts';
import type { Host } from '../src/core/types.ts';

const BINDING: VsCodeBinding = {
  envVar: 'CLAUDE_CONFIG_DIR',
  extensionEnvKey: 'claudeCode.environmentVariables',
};

function scratch(contents: string): { host: Host; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'));
  process.env.BATON_HOME = path.join(dir, 'home');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, contents, 'utf8');
  return {
    dir,
    file,
    host: { id: 'test', label: 'Test', configFile: file, inconsistent: false, providerId: 'claude' },
  };
}

test('rewrites both keys and preserves comments and trailing commas', () => {
  // Mirrors a real Antigravity settings.json, which is JSONC, not strict JSON.
  const { host, file } = scratch(`{
  // my editor settings
  "editor.fontSize": 14,
  "claudeCode.environmentVariables": [
    {
      "name": "CLAUDE_CONFIG_DIR",
      "value": "/old/path",
    },
  ],
  "${terminalEnvKey()}": {
    "CLAUDE_CONFIG_DIR": "/old/path",
  },
}`);

  bindVsCodeHost(host, '/new/path', BINDING);
  const text = fs.readFileSync(file, 'utf8');
  const out = readJsonc(file);

  assert.equal((out[terminalEnvKey()] as Record<string, string>).CLAUDE_CONFIG_DIR, '/new/path');
  const list = out['claudeCode.environmentVariables'] as { name: string; value: string }[];
  assert.equal(list.length, 1, 'patches in place rather than appending a duplicate');
  assert.equal(list[0]!.value, '/new/path');
  assert.match(text, /\/\/ my editor settings/, 'comment survives');
  assert.equal(out['editor.fontSize'], 14, 'unrelated settings untouched');
  assert.ok(!text.includes('/old/path'), 'no stale value left behind');
});

test('adds both keys to a settings file that has neither', () => {
  const { host, file } = scratch('{\n  "editor.fontSize": 12\n}');
  bindVsCodeHost(host, '/fresh', BINDING);
  const out = readJsonc(file);
  assert.equal((out[terminalEnvKey()] as Record<string, string>).CLAUDE_CONFIG_DIR, '/fresh');
  const list = out['claudeCode.environmentVariables'] as { name: string; value: string }[];
  assert.equal(list[0]!.value, '/fresh');
  assert.equal(out['editor.fontSize'], 12);
});

test('repairs a half-applied manual edit where only one key was set', () => {
  const { host, file } = scratch(`{
  "claudeCode.environmentVariables": [
    { "name": "CLAUDE_CONFIG_DIR", "value": "/only-here" }
  ]
}`);
  bindVsCodeHost(host, '/both', BINDING);
  const out = readJsonc(file);
  assert.equal((out[terminalEnvKey()] as Record<string, string>).CLAUDE_CONFIG_DIR, '/both');
  assert.equal(
    (out['claudeCode.environmentVariables'] as { value: string }[])[0]!.value,
    '/both',
  );
});

test('leaves other env vars in the extension array alone', () => {
  const { host, file } = scratch(`{
  "claudeCode.environmentVariables": [
    { "name": "SOME_OTHER_VAR", "value": "keepme" },
    { "name": "CLAUDE_CONFIG_DIR", "value": "/old" }
  ]
}`);
  bindVsCodeHost(host, '/new', BINDING);
  const list = readJsonc(file)['claudeCode.environmentVariables'] as {
    name: string;
    value: string;
  }[];
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.name === 'SOME_OTHER_VAR')!.value, 'keepme');
  assert.equal(list.find((e) => e.name === 'CLAUDE_CONFIG_DIR')!.value, '/new');
});

test('dry run writes nothing', () => {
  const { host, file } = scratch('{"editor.fontSize": 9}');
  const before = fs.readFileSync(file, 'utf8');
  bindVsCodeHost(host, '/nope', BINDING, { dryRun: true });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
