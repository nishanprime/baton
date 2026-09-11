import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateFor, costOf, RATES } from '../src/providers/claude/pricing.ts';

test('known models price at their published rate', () => {
  assert.equal(rateFor('claude-opus-5')!.input, 5);
  assert.equal(rateFor('claude-opus-5')!.output, 25);
  assert.equal(rateFor('claude-sonnet-5')!.input, 2);
  assert.equal(rateFor('claude-haiku-4-5')!.input, 1);
});

test('cache write bills at 1.25x input and read at 0.1x', () => {
  const r = rateFor('claude-opus-5')!;
  assert.equal(r.cacheWrite, 5 * 1.25);
  assert.equal(r.cacheRead, 5 * 0.1);
});

test('a model publishing its own cache-read rate overrides the 0.1x default', () => {
  // Fable 5.1 publishes $0.25/MTok rather than 10% of its $10 input rate.
  assert.equal(rateFor('claude-fable-5-1')!.cacheRead, 0.25);
  assert.notEqual(rateFor('claude-fable-5-1')!.cacheRead, 10 * 0.1);
});

test('a dated snapshot falls back to its base model', () => {
  const dated = rateFor('claude-haiku-4-5-20251001');
  assert.ok(dated, 'dated snapshot should still price');
  assert.equal(dated!.input, RATES['claude-haiku-4-5']!.input);
});

test('an unseen model falls back by family rather than pricing at zero', () => {
  assert.equal(rateFor('claude-opus-9-future')!.input, 5, 'opus family');
  assert.equal(rateFor('claude-sonnet-9-future')!.input, 2, 'sonnet family');
  assert.equal(rateFor('claude-haiku-9-future')!.input, 1, 'haiku family');
});

test('a genuinely unknown model prices as null, never silently zero', () => {
  assert.equal(rateFor('some-other-vendor-model'), null);
  assert.equal(costOf('some-other-vendor-model', { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 }), null);
});

test('cost is per million tokens', () => {
  const cost = costOf('claude-opus-5', { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 });
  assert.equal(cost, 5);
});

test('cost sums every token class', () => {
  const cost = costOf('claude-sonnet-5', {
    input: 1_000_000,      // $2.00
    output: 1_000_000,     // $10.00
    cacheWrite: 1_000_000, // $2.50
    cacheRead: 1_000_000,  // $0.20
  });
  assert.ok(Math.abs(cost! - 14.7) < 1e-9, `expected 14.70, got ${cost}`);
});

test('zero usage costs nothing', () => {
  assert.equal(costOf('claude-opus-5', { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), 0);
});
