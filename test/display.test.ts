import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskEmail,
  makeProjectMasker,
  accountLabel,
  accountEmail,
  maskPath,
  maskPathsInText,
} from '../src/core/display.ts';
import { DEFAULTS } from '../src/core/settings.ts';

const settings = (over = {}) => ({
  ...structuredClone(DEFAULTS),
  display: { aliases: {}, hideEmails: false, hideProjects: false, ...over },
});

test('a masked email keeps only the first letter and the tld', () => {
  const out = maskEmail('dana@northwind.com');
  assert.ok(out.startsWith('n'), 'keeps the first letter as a hint');
  assert.ok(out.endsWith('.com'), 'keeps the tld');
  assert.ok(!out.includes('work'), 'domain is hidden');
  assert.ok(!out.includes('ishan'), 'local part is hidden');
});

test('masking a missing email says so rather than producing junk', () => {
  assert.equal(maskEmail(null), 'not logged in');
  assert.equal(maskEmail(undefined), 'not logged in');
});

test('project pseudonyms are stable and distinct', () => {
  const mask = makeProjectMasker(['zebra', 'apple', 'mango']);
  assert.equal(mask('apple'), 'Project A', 'assigned in sorted order');
  assert.equal(mask('mango'), 'Project B');
  assert.equal(mask('zebra'), 'Project C');
  // Stability is the point: a redacted screenshot must stay readable.
  assert.equal(makeProjectMasker(['mango', 'zebra', 'apple'])('apple'), 'Project A');
});

test('project pseudonyms survive more than 26 projects', () => {
  const many = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const mask = makeProjectMasker(many);
  const all = new Set(many.map(mask));
  assert.equal(all.size, 30, 'every project gets a distinct label');
});

test('an unknown project does not leak its real name', () => {
  assert.equal(makeProjectMasker(['a'])('never-seen'), 'Project ?');
});

test('aliases are cosmetic and fall back to the id', () => {
  assert.equal(accountLabel('work', settings()), 'work');
  assert.equal(accountLabel('work', settings({ aliases: { work: 'Work' } })), 'Work');
});

test('emails are shown in full unless hiding is on', () => {
  assert.equal(accountEmail('a@b.com', settings()), 'a@b.com');
  assert.notEqual(accountEmail('a@b.com', settings({ hideEmails: true })), 'a@b.com');
});

test('home is shortened to ~ even when not hiding projects', () => {
  const out = maskPath('/home/me/.claude-work', settings(), '/home/me');
  assert.equal(out, '~/.claude-work');
});

test('a path outside home is left alone', () => {
  assert.equal(maskPath('/opt/thing', settings(), '/home/me'), '/opt/thing');
});

test('hiding projects redacts intermediate path segments', () => {
  const out = maskPath('/home/me/Documents/Secret/repo', settings({ hideProjects: true }), '/home/me');
  assert.ok(!out.includes('Secret'), `segment leaked: ${out}`);
});

test('paths inside free text are redacted too', () => {
  const text = 'open /home/me/Clients/Acme/plan.md please';
  const out = maskPathsInText(text, settings({ hideProjects: true }), '/home/me');
  assert.ok(!out.includes('Acme'), `client name leaked: ${out}`);
  assert.ok(out.includes('please'), 'surrounding prose is preserved');
});
