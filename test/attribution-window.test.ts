import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAttribution, clearAttributionCache } from '../src/core/attribution.ts';

/**
 * A session id is not a stable key for an account.
 *
 * A conversation can be resumed later under a different account, and an
 * attribution record only describes the window it was actually observed in.
 * Answering from the id alone reported a limit hit hours earlier as belonging
 * to whichever account holds that transcript now — so the account the user had
 * just switched TO showed as spent, and the one that actually ran out showed as
 * ready. Exactly backwards, and stated with full confidence.
 */
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-attr-'));
  process.env.BATON_HOME = home;
  clearAttributionCache();
});

function record(opts: { sessionId: string; accountId: string; firstSeen: string; lastSeen: string; cwd?: string }): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'attribution.json'),
    JSON.stringify({
      version: 1,
      since: opts.firstSeen,
      records: {
        [`sid:${opts.sessionId}`]: {
          providerId: 'claude',
          accountId: opts.accountId,
          sessionId: opts.sessionId,
          cwd: opts.cwd ?? null,
          pid: 123,
          startedAt: opts.firstSeen,
          editor: 'cursor',
          firstSeen: opts.firstSeen,
          lastSeen: opts.lastSeen,
        },
      },
    }),
    'utf8',
  );
  clearAttributionCache();
}

test('an event inside the observed window is attributed', () => {
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T10:00:00.000Z', lastSeen: '2026-09-11T12:00:00.000Z' });
  const who = resolveAttribution('S1', { at: '2026-09-11T11:00:00.000Z' });
  assert.equal(who?.accountId, 'work');
  assert.equal(who?.confidence, 'exact');
});

test('an event BEFORE the observed window is not attributed', () => {
  // The real case: recording began at 22:08, the limit hit at 19:36, and the
  // transcript is now open under a different account.
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T22:08:00.000Z', lastSeen: '2026-09-11T22:30:00.000Z' });
  assert.equal(
    resolveAttribution('S1', { at: '2026-09-11T19:36:00.000Z' }),
    null,
    'a session observed only after the event cannot be blamed for it',
  );
});

test('an event long after the observed window is not attributed', () => {
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T10:00:00.000Z', lastSeen: '2026-09-11T10:30:00.000Z' });
  assert.equal(resolveAttribution('S1', { at: '2026-09-11T18:00:00.000Z' }), null);
});

test('the window has a grace margin, since polling is not continuous', () => {
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T10:00:00.000Z', lastSeen: '2026-09-11T10:30:00.000Z' });
  // A minute past lastSeen is the same session, just between two polls.
  assert.equal(resolveAttribution('S1', { at: '2026-09-11T10:31:00.000Z' })?.accountId, 'work');
});

test('with no time to check, an id match still answers', () => {
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T10:00:00.000Z', lastSeen: '2026-09-11T10:30:00.000Z' });
  assert.equal(resolveAttribution('S1', {})?.accountId, 'work');
});

test('an unknown session is unresolved rather than guessed', () => {
  record({ sessionId: 'S1', accountId: 'work', firstSeen: '2026-09-11T10:00:00.000Z', lastSeen: '2026-09-11T10:30:00.000Z' });
  assert.equal(resolveAttribution('NEVER-SEEN', { at: '2026-09-11T10:15:00.000Z' }), null);
});
