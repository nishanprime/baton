import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists } from './paths.ts';
import { textOf } from './history.ts';
import type { Provider } from './types.ts';

export interface LimitEvent {
  providerId: string;
  sessionId: string;
  project: string;
  cwd: string;
  /** ISO timestamp of the error message. */
  at: string;
  /** Human reset text as the provider worded it, e.g. "4:10am (America/New_York)". */
  resets: string | null;
  message: string;
}

/**
 * How a provider says an account is spent.
 *
 * Taken from real transcripts rather than guessed: Claude Code writes an
 * assistant message with isApiErrorMessage set and text of the form
 * "You've hit your session limit · resets 4:10am (America/New_York)".
 */
const EXHAUSTION_PATTERNS = [
  /hit your (session|usage) limit/i,
  /usage limit reached/i,
  /rate.?limit(ed)?\b/i,
  /out of (credits|quota)/i,
];

const RESETS_RE = /resets?\s+(.+?)(?:$|\n)/i;

const isExhaustion = (text: string): boolean => EXHAUSTION_PATTERNS.some((re) => re.test(text));

function scanFile(file: string, providerId: string, cutoffMs: number): LimitEvent[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }

  const events: LimitEvent[] = [];
  let cwd = '';

  for (const line of lines) {
    // Cheap pre-filter: parsing every line of every transcript is the slow path.
    if (!line.includes('isApiErrorMessage')) {
      if (!cwd && line.includes('"cwd"')) {
        try {
          cwd = (JSON.parse(line) as { cwd?: string }).cwd ?? '';
        } catch { /* ignore */ }
      }
      continue;
    }

    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!d.isApiErrorMessage) continue;

    const text = textOf(d.message) ?? '';
    if (!isExhaustion(text)) continue;

    const at = (d.timestamp as string | undefined) ?? '';
    if (at && Date.parse(at) < cutoffMs) continue;

    events.push({
      providerId,
      sessionId: path.basename(file, '.jsonl'),
      project: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
      cwd: (d.cwd as string | undefined) ?? cwd,
      at,
      resets: RESETS_RE.exec(text)?.[1]?.trim() ?? null,
      message: text.trim(),
    });
  }
  return events;
}

/**
 * Exhaustion events across the pooled history, newest first.
 *
 * Only files touched inside the window are opened, so a routine poll costs a
 * directory stat rather than a full re-read of every transcript.
 */
export function findLimitEvents(
  providers: Provider[],
  opts: { sinceMinutes?: number } = {},
): LimitEvent[] {
  const sinceMinutes = opts.sinceMinutes ?? 30;
  const cutoffMs = Date.now() - sinceMinutes * 60_000;
  const out: LimitEvent[] = [];

  for (const provider of providers) {
    const root = path.join(sharedStore(provider.id), 'projects');
    if (!exists(root)) continue;

    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const full = path.join(root, dir);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.name.endsWith('.jsonl')) continue;
        const file = path.join(full, f.name);
        try {
          if (fs.statSync(file).mtimeMs < cutoffMs) continue;
        } catch {
          continue;
        }
        out.push(...scanFile(file, provider.id, cutoffMs));
      }
    }
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}
