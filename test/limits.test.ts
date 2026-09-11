import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLimitEvents } from '../src/core/limits.ts';
import { claudeProvider } from '../src/providers/claude/index.ts';

let root: string;
let projects: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-limits-'));
  process.env.BATON_HOME = root;
  projects = path.join(root, 'shared', 'claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
});

/** Write a transcript whose lines are the given records. */
function transcript(name: string, records: unknown[]): string {
  const file = path.join(projects, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  return file;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const limitLine = (minutesAgo: number, text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  timestamp: at(minutesAgo),
  cwd: '/work/proj',
  message: { content: [{ type: 'text', text }] },
});

test('finds the real exhaustion message and its reset time', () => {
  transcript('s1', [
    { type: 'user', timestamp: at(10), cwd: '/work/proj', message: { content: 'hi' } },
    limitLine(5, "You've hit your session limit · resets 7:40pm (America/New_York)"),
  ]);

  const events = findLimitEvents([claudeProvider], { sinceMinutes: 60 });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.resets, '7:40pm (America/New_York)');
  assert.equal(events[0]!.sessionId, 's1');
  assert.equal(events[0]!.project, 'proj');
});

test('ignores errors that are not exhaustion', () => {
  transcript('s1', [limitLine(5, 'Request failed: connection reset by peer')]);
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 60 }).length, 0);
});

test('ignores an ordinary message that merely mentions a limit', () => {
  transcript('s1', [
    {
      type: 'assistant',
      timestamp: at(5),
      cwd: '/work/proj',
      message: { content: [{ type: 'text', text: 'The rate limit for that API is 100/min.' }] },
    },
  ]);
  assert.equal(
    findLimitEvents([claudeProvider], { sinceMinutes: 60 }).length,
    0,
    'isApiErrorMessage is what makes it an event, not the words',
  );
});

test('events outside the window are excluded', () => {
  transcript('s1', [limitLine(600, "You've hit your session limit · resets 9:00am")]);
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 30 }).length, 0);
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 1000 }).length, 1);
});

test('newest first across several transcripts', () => {
  transcript('older', [limitLine(20, "You've hit your session limit · resets 1:00pm")]);
  transcript('newer', [limitLine(2, "You've hit your session limit · resets 2:00pm")]);
  const events = findLimitEvents([claudeProvider], { sinceMinutes: 60 });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.sessionId, 'newer');
});

test('alternate wordings are recognised', () => {
  transcript('s1', [limitLine(5, 'Claude AI usage limit reached')]);
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 60 }).length, 1);
});

test('a malformed line does not abort the scan', () => {
  const file = path.join(projects, 's1.jsonl');
  fs.writeFileSync(
    file,
    ['{ not json at all', JSON.stringify(limitLine(5, "You've hit your session limit · resets 3:00pm"))].join('\n'),
    'utf8',
  );
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 60 }).length, 1);
});

test('an empty store yields nothing rather than throwing', () => {
  fs.rmSync(path.join(root, 'shared'), { recursive: true, force: true });
  assert.deepEqual(findLimitEvents([claudeProvider], { sinceMinutes: 60 }), []);
});

test('an org running out of credit counts as exhaustion', () => {
  // Found in real transcripts and previously missed. It stops work exactly as
  // a personal limit does, and is the case where switching is most likely the
  // answer.
  transcript('s1', [limitLine(5, "You've hit your org's monthly spend limit · run /usage-credits to raise it")]);
  assert.equal(findLimitEvents([claudeProvider], { sinceMinutes: 60 }).length, 1);
});
