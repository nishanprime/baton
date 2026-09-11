import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPin, removePin, listPins, pinFor } from '../src/core/pins.ts';

beforeEach(() => {
  process.env.BATON_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-pins-'));
});

test('a pin covers its whole subtree', () => {
  setPin('/work', 'company');
  assert.equal(pinFor('/work')?.accountId, 'company');
  assert.equal(pinFor('/work/repo')?.accountId, 'company');
  assert.equal(pinFor('/work/repo/src/deep')?.accountId, 'company');
});

test('a deeper pin overrides a shallower one', () => {
  setPin('/work', 'company');
  setPin('/work/side', 'personal');
  assert.equal(pinFor('/work/other')?.accountId, 'company');
  assert.equal(pinFor('/work/side')?.accountId, 'personal');
  assert.equal(pinFor('/work/side/nested')?.accountId, 'personal');
});

test('a sibling with a shared prefix is not captured', () => {
  setPin('/work', 'company');
  // /workshop must not match /work just because the string starts the same.
  assert.equal(pinFor('/workshop'), null);
});

test('an unpinned directory resolves to nothing', () => {
  assert.equal(pinFor('/elsewhere'), null);
});

test('a trailing slash is normalised away', () => {
  setPin('/work/', 'company');
  assert.equal(pinFor('/work')?.accountId, 'company');
  assert.equal(listPins()[0]!.dir, '/work');
});

test('re-pinning replaces rather than duplicating', () => {
  setPin('/work', 'company');
  setPin('/work', 'personal');
  assert.equal(listPins().length, 1);
  assert.equal(pinFor('/work')?.accountId, 'personal');
});

test('unpinning removes only that pin', () => {
  setPin('/work', 'company');
  setPin('/play', 'personal');
  assert.equal(removePin('/work'), true);
  assert.equal(pinFor('/work'), null);
  assert.equal(pinFor('/play')?.accountId, 'personal');
});

test('unpinning something unpinned reports false rather than throwing', () => {
  assert.equal(removePin('/never-pinned'), false);
});

test('pins list most specific first', () => {
  setPin('/a', 'x');
  setPin('/a/b/c', 'y');
  setPin('/a/b', 'z');
  assert.deepEqual(listPins().map((p) => p.dir), ['/a/b/c', '/a/b', '/a']);
});

test('a relative path is stored absolute', () => {
  const pin = setPin('.', 'here');
  assert.ok(path.isAbsolute(pin.dir));
});
