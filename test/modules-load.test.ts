import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import every module.
 *
 * The project runs TypeScript through Node's type-stripping, which supports
 * less than tsc accepts — parameter properties, enums and namespaces all
 * typecheck cleanly and then throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the first
 * time the file is loaded. A green `tsc --noEmit` is therefore not evidence
 * that the code runs, and a module only reached from one CLI branch can ship
 * broken. Loading each one is the cheapest way to close that gap.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(path.join(root, 'src'));

test('every source file is discovered', () => {
  assert.ok(files.length > 10, `expected the src tree, found ${files.length} files`);
});

for (const file of files) {
  const rel = path.relative(root, file);
  // cli.ts runs its dispatch on import, so it is exercised separately.
  if (rel.endsWith('cli.ts')) continue;

  test(`loads: ${rel}`, async () => {
    await assert.doesNotReject(
      () => import(file),
      `${rel} failed to load — usually TypeScript that tsc allows but the runtime does not`,
    );
  });
}
