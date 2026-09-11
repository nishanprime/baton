import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists, appHome } from './paths.ts';
import type { Provider } from './types.ts';

export interface Conversation {
  providerId: string;
  sessionId: string;
  /** Working directory the session ran in, read from the transcript itself. */
  cwd: string;
  project: string;
  title: string;
  /** Exact turn count, or null when the transcript was too large to read whole. */
  messages: number | null;
  sizeBytes: number;
  startedAt: string | null;
  updatedAt: string | null;
  /**
   * How the session was launched, e.g. claude-vscode. This identifies the
   * integration, not the specific editor — transcripts do not record whether
   * a VS Code-family session was Cursor, Antigravity or stock VS Code.
   */
  launchedFrom: string | null;
  gitBranch: string | null;
  file: string;
}

/**
 * First human turn, trimmed to something that reads as a title.
 *
 * Real prompts are routinely wrapped in injected blocks — system reminders,
 * IDE selections, command output — so those are stripped before the text is
 * judged empty, or every session that opens with one would be untitled.
 */
export function titleFrom(text: string): string {
  const clean = text
    .replace(/<(system-reminder|ide_selection|command-[a-z-]+|local-command-[a-z-]+)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

/**
 * All text parts of a message, joined.
 *
 * A single turn routinely carries several text parts — an injected block and
 * then the actual prompt — so taking only the first finds the wrapper and
 * misses what the person typed.
 */
export function textOf(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts = content
    .filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => (c as { text?: string }).text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  return parts.length ? parts.join('\n') : null;
}

/** Bytes read from the start of a transcript: enough for the opening turns. */
const HEAD_BYTES = 256 * 1024;
/** Bytes read from the end: enough for the final timestamped entry. */
const TAIL_BYTES = 64 * 1024;

/**
 * Read only the head and tail of a transcript.
 *
 * Everything the list needs — title, project, launch source, first and last
 * timestamp — lives in the opening and closing lines. Reading whole files to
 * reach them meant hundreds of MB of I/O per listing, for metadata measured in
 * bytes. An exact message count is the one thing this gives up, so it is
 * reported only when the file was small enough to be read whole.
 */
function readHeadAndTail(file: string): { head: string; tail: string; size: number; whole: boolean } | null {
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }

  try {
    if (size <= HEAD_BYTES) {
      const buf = Buffer.allocUnsafe(size);
      fs.readSync(fd, buf, 0, size, 0);
      return { head: buf.toString('utf8'), tail: '', size, whole: true };
    }

    const headBuf = Buffer.allocUnsafe(HEAD_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);

    const tailLen = Math.min(TAIL_BYTES, size - HEAD_BYTES);
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);

    return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8'), size, whole: false };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readOne(file: string, providerId: string): Conversation | null {
  const chunk = readHeadAndTail(file);
  if (!chunk) return null;

  // A partial read can slice a line in half at either boundary; drop those.
  const headLines = chunk.head.split('\n').filter(Boolean);
  if (!chunk.whole && headLines.length) headLines.pop();
  const tailLines = chunk.tail.split('\n').filter(Boolean).slice(1);

  const lines = [...headLines, ...tailLines];
  if (!lines.length) return null;

  let cwd = '';
  let title = '';
  let launchedFrom: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  let messages = 0;

  for (const line of lines) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = d.type as string | undefined;
    if (type === 'user' || type === 'assistant') messages++;

    const ts = d.timestamp as string | undefined;
    if (ts) {
      startedAt ??= ts;
      updatedAt = ts;
    }

    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd;
    if (!launchedFrom && typeof d.entrypoint === 'string') launchedFrom = d.entrypoint;
    if (!gitBranch && typeof d.gitBranch === 'string') gitBranch = d.gitBranch;

    // The first genuinely human turn, not a tool result or an injected reminder.
    if (
      !title &&
      type === 'user' &&
      (d.origin as { kind?: string } | undefined)?.kind !== 'task-notification' &&
      !d.isSidechain
    ) {
      const text = textOf(d.message);
      // Strip the wrappers first, then judge — a prompt preceded by an
      // injected block still has a perfectly good title inside it.
      if (text) title = titleFrom(text);
    }
  }

  if (!messages) return null;

  return {
    providerId,
    sessionId: path.basename(file, '.jsonl'),
    cwd,
    project: cwd ? path.basename(cwd) : path.basename(path.dirname(file)),
    title: title || '(no prompt)',
    messages: chunk.whole ? messages : null,
    sizeBytes: chunk.size,
    startedAt,
    updatedAt,
    launchedFrom,
    gitBranch,
    file,
  };
}

export interface HistoryFilter {
  project?: string;
  launchedFrom?: string;
  search?: string;
  /** Page size. */
  limit?: number;
  /** Rows to skip, for paging. */
  offset?: number;
}

export interface HistoryPage {
  conversations: Conversation[];
  /** Rows matching the filter, before paging. */
  total: number;
  /** Conversations in the store, before filtering. */
  totalUnfiltered: number;
  offset: number;
  limit: number | null;
  hasMore: boolean;
  /** Files re-parsed this call; the rest came from cache. */
  reparsed: number;
}

// --------------------------------------------------------------- cache
//
// Parsing every transcript on every call means re-reading hundreds of MB to
// answer a question whose answer almost never changes. Entries are keyed by
// mtime and size, so only files actually written since the last call are read.

interface CacheEntry {
  mtimeMs: number;
  size: number;
  conv: Conversation | null;
}

const CACHE_VERSION = 2;
const cacheFile = () => path.join(appHome(), 'cache', 'history-index.json');

function loadCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as {
      version?: number;
      entries?: Record<string, CacheEntry>;
    };
    // A parser change invalidates everything it produced.
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
  } catch {
    /* a cache that cannot be written is a slowdown, not a failure */
  }
}

/**
 * Every conversation in the shared store, newest first.
 *
 * Reads the pooled store rather than any one account, so the list is the same
 * regardless of which account is currently active — that is the whole point of
 * pooling in the first place.
 */
export function listConversations(
  providers: Provider[],
  filter: HistoryFilter = {},
): HistoryPage {
  const cache = loadCache();
  const fresh: Record<string, CacheEntry> = {};
  const out: Conversation[] = [];
  let reparsed = 0;

  for (const provider of providers) {
    const root = path.join(sharedStore(provider.id), 'projects');
    if (!exists(root)) continue;

    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const dir of projectDirs) {
      const full = path.join(root, dir);
      let files: string[];
      try {
        files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const f of files) {
        const file = path.join(full, f);

        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }

        const hit = cache[file];
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
          fresh[file] = hit;
          if (hit.conv) out.push(hit.conv);
          continue;
        }

        const conv = readOne(file, provider.id);
        reparsed++;
        fresh[file] = { mtimeMs: stat.mtimeMs, size: stat.size, conv };
        if (conv) out.push(conv);
      }
    }
  }

  if (reparsed || Object.keys(fresh).length !== Object.keys(cache).length) saveCache(fresh);

  const totalUnfiltered = out.length;
  let result = out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  if (filter.project) result = result.filter((c) => c.project === filter.project);
  if (filter.launchedFrom) result = result.filter((c) => c.launchedFrom === filter.launchedFrom);
  if (filter.search) {
    const q = filter.search.toLowerCase();
    result = result.filter(
      (c) => c.title.toLowerCase().includes(q) || c.project.toLowerCase().includes(q),
    );
  }

  const total = result.length;
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = filter.limit ?? null;
  const page = limit === null ? result.slice(offset) : result.slice(offset, offset + limit);

  return {
    conversations: page,
    total,
    totalUnfiltered,
    offset,
    limit,
    hasMore: limit !== null && offset + page.length < total,
    reparsed,
  };
}

/** Distinct values available for the filter controls. */
export function historyFacets(conversations: Conversation[]) {
  const count = <K extends keyof Conversation>(key: K) => {
    const m = new Map<string, number>();
    for (const c of conversations) {
      const v = c[key];
      if (typeof v === 'string' && v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, count: n }));
  };
  return {
    projects: count('project'),
    launchedFrom: count('launchedFrom'),
    providers: count('providerId'),
  };
}
