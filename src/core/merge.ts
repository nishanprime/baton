import fs from 'node:fs';
import path from 'node:path';

export interface MergeOutcome {
  strategy: 'identical' | 'json-merged' | 'markdown-appended' | 'store-wins';
  /** Keys whose values genuinely disagreed; the store's value was kept. */
  conflicts: string[];
}

/** Union two arrays, comparing by serialised value so objects dedupe too. */
function unionArrays(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map((v) => JSON.stringify(v)));
  const out = [...a];
  for (const v of b) {
    const k = JSON.stringify(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively fold `incoming` into `base`.
 *
 * Objects recurse, arrays union, and equal scalars are a no-op — so settings
 * files combine cleanly in every case except a genuine disagreement on the same
 * scalar key, which is reported rather than silently resolved.
 */
export function deepMerge(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  conflicts: string[] = [],
  prefix = '',
): Record<string, unknown> {
  for (const [key, value] of Object.entries(incoming)) {
    const at = prefix ? `${prefix}.${key}` : key;

    if (!(key in base)) {
      base[key] = value;
    } else if (isPlainObject(base[key]) && isPlainObject(value)) {
      deepMerge(base[key] as Record<string, unknown>, value, conflicts, at);
    } else if (Array.isArray(base[key]) && Array.isArray(value)) {
      base[key] = unionArrays(base[key] as unknown[], value);
    } else if (JSON.stringify(base[key]) !== JSON.stringify(value)) {
      conflicts.push(at); // base (the store) wins
    }
  }
  return base;
}

/**
 * Combine a single-value file that already exists in the store with an
 * incoming copy from another account, choosing a strategy by file type.
 */
export function mergeFile(srcFile: string, dstFile: string): MergeOutcome {
  const src = fs.readFileSync(srcFile, 'utf8');
  const dst = fs.readFileSync(dstFile, 'utf8');

  if (src === dst) return { strategy: 'identical', conflicts: [] };

  const ext = path.extname(srcFile).toLowerCase();

  if (ext === '.json') {
    try {
      const conflicts: string[] = [];
      const merged = deepMerge(
        JSON.parse(dst) as Record<string, unknown>,
        JSON.parse(src) as Record<string, unknown>,
        conflicts,
      );
      fs.writeFileSync(dstFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      return { strategy: 'json-merged', conflicts };
    } catch {
      return { strategy: 'store-wins', conflicts: ['unparseable JSON'] };
    }
  }

  if (ext === '.md') {
    // Instructions are additive: keep both, and say where each half came from
    // so the user can prune by hand later.
    const tag = path.basename(path.dirname(srcFile));
    fs.writeFileSync(dstFile, `${dst.trimEnd()}\n\n<!-- merged from ${tag} -->\n\n${src.trimStart()}`, 'utf8');
    return { strategy: 'markdown-appended', conflicts: [] };
  }

  return { strategy: 'store-wins', conflicts: [] };
}
