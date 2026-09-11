import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUsageReport } from '../src/core/usage.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

let root: string;
let projects: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-usage-'));
  process.env.BATON_HOME = root;
  projects = path.join(root, 'shared', 'claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
});

const turn = (model: string, u: Record<string, number>) => ({
  type: 'assistant',
  timestamp: '2026-09-01T10:00:00.000Z',
  message: { model, usage: u },
});

function transcript(name: string, records: unknown[]): void {
  fs.writeFileSync(
    path.join(projects, `${name}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n'),
    'utf8',
  );
}

test('tokens are totalled per model and priced', () => {
  transcript('s1', [
    turn('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }),
  ]);
  const r = buildUsageReport([claudeProvider]);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0]!.model, 'claude-opus-5');
  assert.equal(r.models[0]!.input, 1_000_000);
  assert.equal(r.models[0]!.costUsd, 5, '$5 per million input on opus');
});

test('every token class contributes to cost', () => {
  transcript('s1', [
    turn('claude-sonnet-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    }),
  ]);
  const r = buildUsageReport([claudeProvider]);
  assert.ok(Math.abs(r.totals.costUsd - 14.7) < 1e-9, `got ${r.totals.costUsd}`);
});

test('several models are separated and sorted by cost', () => {
  transcript('s1', [
    turn('claude-haiku-4-5', { input_tokens: 1_000_000 }),
    turn('claude-opus-5', { input_tokens: 1_000_000 }),
  ]);
  const r = buildUsageReport([claudeProvider]);
  assert.equal(r.models.length, 2);
  assert.equal(r.models[0]!.model, 'claude-opus-5', 'most expensive first');
  assert.equal(r.totals.turns, 2);
});

test('turns accumulate across transcripts', () => {
  transcript('a', [turn('claude-opus-5', { input_tokens: 10 })]);
  transcript('b', [turn('claude-opus-5', { input_tokens: 20 })]);
  const r = buildUsageReport([claudeProvider]);
  assert.equal(r.conversations, 2);
  assert.equal(r.models[0]!.turns, 2);
  assert.equal(r.models[0]!.input, 30);
});

test('turns without usage are ignored rather than counted as zero-cost turns', () => {
  transcript('s1', [
    { type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: { content: 'hi' } },
    turn('claude-opus-5', { input_tokens: 5 }),
  ]);
  assert.equal(buildUsageReport([claudeProvider]).totals.turns, 1);
});

test('a second call is served from cache', () => {
  transcript('s1', [turn('claude-opus-5', { input_tokens: 1 })]);
  assert.ok(buildUsageReport([claudeProvider]).reparsed > 0, 'cold parses');
  assert.equal(buildUsageReport([claudeProvider]).reparsed, 0, 'warm parses nothing');
});

test('a changed transcript is re-read', () => {
  transcript('s1', [turn('claude-opus-5', { input_tokens: 1 })]);
  buildUsageReport([claudeProvider]);
  transcript('s1', [
    turn('claude-opus-5', { input_tokens: 1 }),
    turn('claude-opus-5', { input_tokens: 999 }),
  ]);
  const r = buildUsageReport([claudeProvider]);
  assert.ok(r.reparsed > 0, 'mtime/size change forces a re-read');
  assert.equal(r.models[0]!.input, 1000);
});

test('an unknown model still counts tokens but prices as null', () => {
  transcript('s1', [turn('some-other-vendor', { input_tokens: 100 })]);
  const r = buildUsageReport([claudeProvider]);
  assert.equal(r.models[0]!.input, 100);
  assert.equal(r.models[0]!.costUsd, null, 'never invent a price');
  assert.equal(r.totals.costUsd, 0, 'unpriced tokens add nothing to the total');
});

test('an empty store reports zeroes rather than throwing', () => {
  fs.rmSync(path.join(root, 'shared'), { recursive: true, force: true });
  const r = buildUsageReport([claudeProvider]);
  assert.equal(r.conversations, 0);
  assert.equal(r.totals.costUsd, 0);
});
