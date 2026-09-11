import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists } from './paths.ts';
import type { Provider } from './types.ts';

export interface Conversation {
  providerId: string;
  sessionId: string;
  /** Working directory the session ran in, read from the transcript itself. */
  cwd: string;
  project: string;
  title: string;
  messages: number;
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

function readOne(file: string, providerId: string): Conversation | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter(Boolean);
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
    messages,
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
  limit?: number;
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
): Conversation[] {
  const out: Conversation[] = [];

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
        const conv = readOne(path.join(full, f), provider.id);
        if (conv) out.push(conv);
      }
    }
  }

  let result = out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  if (filter.project) result = result.filter((c) => c.project === filter.project);
  if (filter.launchedFrom) result = result.filter((c) => c.launchedFrom === filter.launchedFrom);
  if (filter.search) {
    const q = filter.search.toLowerCase();
    result = result.filter(
      (c) => c.title.toLowerCase().includes(q) || c.project.toLowerCase().includes(q),
    );
  }
  return filter.limit ? result.slice(0, filter.limit) : result;
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
