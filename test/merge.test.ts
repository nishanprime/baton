import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, mergeFile } from '../src/core/merge.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baton-merge-'));

test('deepMerge unions arrays instead of replacing them', () => {
  const out = deepMerge(
    { permissions: { allow: ['Bash(ls)'] } },
    { permissions: { allow: ['Bash(git)'] } },
  );
  assert.deepEqual((out.permissions as { allow: string[] }).allow, ['Bash(ls)', 'Bash(git)']);
});

test('deepMerge dedupes identical array entries', () => {
  const out = deepMerge({ a: ['x', 'y'] }, { a: ['y', 'z'] });
  assert.deepEqual(out.a, ['x', 'y', 'z']);
});

test('deepMerge adds new keys and reports real conflicts', () => {
  const conflicts: string[] = [];
  const out = deepMerge({ model: 'opus', theme: 'dark' }, { model: 'sonnet', effort: 'high' }, conflicts);
  assert.equal(out.effort, 'high', 'new key added');
  assert.equal(out.model, 'opus', 'base wins a genuine disagreement');
  assert.deepEqual(conflicts, ['model']);
  assert.equal(out.theme, 'dark');
});

test('deepMerge recurses rather than clobbering nested objects', () => {
  const out = deepMerge({ a: { b: 1 } }, { a: { c: 2 } });
  assert.deepEqual(out.a, { b: 1, c: 2 });
});

test('mergeFile detects identical files without rewriting', () => {
  const d = tmp();
  const a = path.join(d, 'a.json');
  const b = path.join(d, 'b.json');
  fs.writeFileSync(a, '{"x":1}');
  fs.writeFileSync(b, '{"x":1}');
  assert.equal(mergeFile(a, b).strategy, 'identical');
  assert.equal(fs.readFileSync(b, 'utf8'), '{"x":1}', 'untouched');
});

test('mergeFile combines two settings files', () => {
  const d = tmp();
  const src = path.join(d, 'src.json');
  const dst = path.join(d, 'dst.json');
  fs.writeFileSync(src, JSON.stringify({ permissions: { allow: ['B'] }, newKey: 1 }));
  fs.writeFileSync(dst, JSON.stringify({ permissions: { allow: ['A'] }, theme: 'dark' }));

  const out = mergeFile(src, dst);
  assert.equal(out.strategy, 'json-merged');

  const merged = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.deepEqual(merged.permissions.allow, ['A', 'B'], 'both permission sets survive');
  assert.equal(merged.newKey, 1);
  assert.equal(merged.theme, 'dark');
});

test('mergeFile keeps both halves of differing instructions', () => {
  const d = path.join(tmp(), 'acct');
  fs.mkdirSync(d, { recursive: true });
  const src = path.join(d, 'CLAUDE.md');
  const dst = path.join(tmp(), 'CLAUDE.md');
  fs.writeFileSync(src, '# From account two');
  fs.writeFileSync(dst, '# From account one');

  assert.equal(mergeFile(src, dst).strategy, 'markdown-appended');
  const text = fs.readFileSync(dst, 'utf8');
  assert.match(text, /From account one/);
  assert.match(text, /From account two/);
  assert.match(text, /merged from acct/, 'records provenance');
});
