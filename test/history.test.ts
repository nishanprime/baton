import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFrom } from '../src/core/history.ts';

test('strips an injected system reminder and keeps the real prompt', () => {
  const t = titleFrom('<system-reminder>ignore me entirely</system-reminder>Fix the login bug');
  assert.equal(t, 'Fix the login bug');
});

test('strips an IDE selection block', () => {
  const t = titleFrom('<ide_selection>some code</ide_selection>Why is this slow?');
  assert.equal(t, 'Why is this slow?');
});

test('keeps a plain prompt unchanged', () => {
  assert.equal(titleFrom('Add a dark mode toggle'), 'Add a dark mode toggle');
});

test('drops fenced code blocks', () => {
  assert.equal(titleFrom('Explain\n```js\nconst x = 1;\n```\nplease'), 'Explain please');
});

test('truncates long prompts with an ellipsis', () => {
  const t = titleFrom('x'.repeat(200));
  assert.equal(t.length, 90);
  assert.ok(t.endsWith('…'));
});

test('returns empty for a prompt that is only an injected block', () => {
  assert.equal(titleFrom('<system-reminder>only this</system-reminder>'), '');
});

test('joins every text part, not just the first', async () => {
  const { textOf } = await import('../src/core/history.ts');
  const msg = {
    content: [
      { type: 'text', text: '<ide_selection>noise</ide_selection>' },
      { type: 'text', text: 'The actual question' },
    ],
  };
  assert.equal(titleFrom(textOf(msg)!), 'The actual question');
});

test('ignores non-text parts', async () => {
  const { textOf } = await import('../src/core/history.ts');
  assert.equal(textOf({ content: [{ type: 'tool_result', content: 'x' }] }), null);
});
