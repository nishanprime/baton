import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists, appHome } from './paths.ts';
import { costOf, type TokenCounts } from '../providers/claude/pricing.ts';
import type { Provider } from './types.ts';

export interface ModelUsage extends TokenCounts {
  model: string;
  turns: number;
  costUsd: number | null;
}

export interface UsageReport {
  models: ModelUsage[];
  totals: TokenCounts & { turns: number; costUsd: number };
  /** Conversations that contributed, and the window they span. */
  conversations: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Files re-parsed this call; the rest came from cache. */
  reparsed: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  perModel: Record<string, TokenCounts & { turns: number }>;
  firstAt: string | null;
  lastAt: string | null;
}

const CACHE_VERSION = 1;
const cacheFile = () => path.join(appHome(), 'cache', 'usage-index.json');

function loadCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as {
      version?: number;
      entries?: Record<string, CacheEntry>;
    };
    return raw.version === CACHE_VERSION ? (raw.entries ?? {}) : {};
  } catch {
    return {};
  }
}

function saveCache(entries: Record<string, CacheEntry>): void {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
  } catch { /* cache is an optimisation, not a requirement */ }
}

const empty = (): TokenCounts & { turns: number } => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  turns: 0,
});

/**
 * Token totals per model for one transcript.
 *
 * Unlike the history listing, this needs every assistant turn, so the whole
 * file is read — which is why the result is cached by mtime and size.
 */
function scanFile(file: string): CacheEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const perModel: Record<string, TokenCounts & { turns: number }> = {};
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.includes('"timestamp"') && (!firstAt || !lastAt)) {
      // fall through to the parse below
    } else if (!line.includes('"usage"')) {
      continue;
    }

    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = d.timestamp as string | undefined;
    if (ts) {
      firstAt ??= ts;
      lastAt = ts;
    }

    const msg = d.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const model = (msg?.model as string | undefined) ?? 'unknown';
    const acc = (perModel[model] ??= empty());
    acc.turns++;
    acc.input += Number(usage.input_tokens ?? 0);
    acc.output += Number(usage.output_tokens ?? 0);
    acc.cacheWrite += Number(usage.cache_creation_input_tokens ?? 0);
    acc.cacheRead += Number(usage.cache_read_input_tokens ?? 0);
  }

  return Object.keys(perModel).length
    ? { mtimeMs: 0, size: 0, perModel, firstAt, lastAt }
    : { mtimeMs: 0, size: 0, perModel: {}, firstAt, lastAt };
}

export function buildUsageReport(providers: Provider[]): UsageReport {
  const cache = loadCache();
  const fresh: Record<string, CacheEntry> = {};
  const totalsByModel: Record<string, TokenCounts & { turns: number }> = {};
  let conversations = 0;
  let reparsed = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const provider of providers) {
    const root = path.join(sharedStore(provider.id), 'projects');
    if (!exists(root)) continue;

    for (const dir of fs.readdirSync(root)) {
      const full = path.join(root, dir);
      let names: string[];
      try {
        names = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const name of names) {
        const file = path.join(full, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }

        let entry = cache[file];
        if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
          const scanned = scanFile(file);
          if (!scanned) continue;
          entry = { ...scanned, mtimeMs: stat.mtimeMs, size: stat.size };
          reparsed++;
        }
        fresh[file] = entry;

        if (!Object.keys(entry.perModel).length) continue;
        conversations++;
        if (entry.firstAt && (!firstAt || entry.firstAt < firstAt)) firstAt = entry.firstAt;
        if (entry.lastAt && (!lastAt || entry.lastAt > lastAt)) lastAt = entry.lastAt;

        for (const [model, counts] of Object.entries(entry.perModel)) {
          const acc = (totalsByModel[model] ??= empty());
          acc.turns += counts.turns;
          acc.input += counts.input;
          acc.output += counts.output;
          acc.cacheWrite += counts.cacheWrite;
          acc.cacheRead += counts.cacheRead;
        }
      }
    }
  }

  if (reparsed) saveCache(fresh);

  const models: ModelUsage[] = Object.entries(totalsByModel)
    .map(([model, c]) => ({ model, ...c, costUsd: costOf(model, c) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  const totals = models.reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      output: acc.output + m.output,
      cacheWrite: acc.cacheWrite + m.cacheWrite,
      cacheRead: acc.cacheRead + m.cacheRead,
      turns: acc.turns + m.turns,
      costUsd: acc.costUsd + (m.costUsd ?? 0),
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0, costUsd: 0 },
  );

  return { models, totals, conversations, firstAt, lastAt, reparsed };
}
