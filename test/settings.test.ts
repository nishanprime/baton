import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSettings,
  saveSettings,
  setSetting,
  setAlias,
  coerce,
  DEFAULTS,
} from '../src/core/settings.ts';

beforeEach(() => {
  process.env.BATON_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-settings-'));
});

test('defaults apply when nothing is saved', () => {
  const s = loadSettings();
  assert.equal(s.autoSwitch.enabled, false);
  assert.equal(s.autoSwitch.mode, 'notify');
  assert.equal(s.showReloadHint, true);
});

test('a partial file is filled in from defaults rather than losing keys', () => {
  const file = path.join(process.env.BATON_HOME!, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ autoSwitch: { enabled: true } }), 'utf8');

  const s = loadSettings();
  assert.equal(s.autoSwitch.enabled, true, 'saved value wins');
  assert.equal(s.autoSwitch.mode, 'notify', 'missing sibling still defaulted');
  assert.equal(s.autoSwitch.pollSeconds, DEFAULTS.autoSwitch.pollSeconds);
  assert.ok(s.display, 'a whole missing block is defaulted');
});

test('a corrupt file falls back to defaults instead of throwing', () => {
  fs.writeFileSync(path.join(process.env.BATON_HOME!, 'settings.json'), '{ broken', 'utf8');
  assert.equal(loadSettings().autoSwitch.mode, 'notify');
});

test('booleans accept the spellings people actually type', () => {
  for (const yes of ['true', 'on', 'yes', '1', 'TRUE']) {
    assert.equal(coerce('autoSwitch.enabled', yes), true, yes);
  }
  for (const no of ['false', 'off', 'no', '0']) {
    assert.equal(coerce('autoSwitch.enabled', no), false, no);
  }
});

test('a nonsense boolean is rejected rather than silently false', () => {
  assert.throws(() => coerce('autoSwitch.enabled', 'maybe'), /expects true or false/);
});

test('an enum setting rejects a value outside its set', () => {
  assert.equal(coerce('autoSwitch.mode', 'switch'), 'switch');
  assert.throws(() => coerce('autoSwitch.mode', 'sideways'), /expects one of/);
});

test('a number setting rejects non-numbers', () => {
  assert.equal(coerce('autoSwitch.pollSeconds', '120'), 120);
  assert.throws(() => coerce('autoSwitch.pollSeconds', 'often'), /expects a number/);
});

test('a list setting splits and trims', () => {
  assert.deepEqual(coerce('autoSwitch.rotation', 'work, personal , '), ['work', 'personal']);
});

test('an unknown key is rejected with the known ones named', () => {
  assert.throws(() => coerce('nope.notAKey', 'x'), /Unknown setting/);
});

test('setting a nested key persists without clobbering siblings', () => {
  setSetting('autoSwitch.mode', 'switch');
  setSetting('autoSwitch.pollSeconds', '300');
  const s = loadSettings();
  assert.equal(s.autoSwitch.mode, 'switch');
  assert.equal(s.autoSwitch.pollSeconds, 300);
  assert.equal(s.autoSwitch.enabled, false, 'untouched sibling survives');
});

test('aliases are set and cleared', () => {
  setAlias('work', 'Work');
  assert.equal(loadSettings().display.aliases.work, 'Work');
  setAlias('work', null);
  assert.ok(!('work' in loadSettings().display.aliases));
});

test('a blank alias clears rather than storing whitespace', () => {
  setAlias('x', 'Name');
  setAlias('x', '   ');
  assert.ok(!('x' in loadSettings().display.aliases));
});

test('saved settings round-trip', () => {
  const s = loadSettings();
  s.showReloadHint = false;
  saveSettings(s);
  assert.equal(loadSettings().showReloadHint, false);
});
