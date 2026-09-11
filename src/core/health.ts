import fs from 'node:fs';
import path from 'node:path';
import { sharedStore, exists } from './paths.ts';
import { findLimitEvents, type LimitEvent } from './limits.ts';
import { findLiveSessions, type LiveSession } from './sessions.ts';
import { listAttributions, resolveAttribution, type AttributionConfidence } from './attribution.ts';
import type { Account, Host, Provider } from './types.ts';

/**
 * Per-account health, for a UI that has to render it.
 *
 * The point of the shapes here is that a missing value always says why it is
 * missing. "Unknown" covers four genuinely different situations and a UI that
 * cannot tell them apart ends up showing a blank cell for all four:
 *
 *   unavailable   — not on disk anywhere, and never will be. See
 *                   UNAVAILABLE_FIELDS. Say so; do not leave a gap that looks
 *                   like a bug.
 *   unsupported   — this platform cannot determine it.
 *   not-recorded  — knowable in principle, but nothing has recorded it yet.
 *                   Usually fixed by letting Baton run.
 *   not-applicable— the question does not apply right now, e.g. a reset time
 *                   for an account that is not spent.
 *
 * Every known value carries where it came from, so the UI can show its
 * provenance instead of asking the reader to trust a number.
 */

export type UnknownReason = 'unavailable' | 'unsupported' | 'not-recorded' | 'not-applicable';

export type Field<T> =
  | { known: true; value: T; source: string }
  | { known: false; reason: UnknownReason; detail: string };

export const knownField = <T>(value: T, source: string): Field<T> => ({ known: true, value, source });

export const unknownField = <T>(reason: UnknownReason, detail: string): Field<T> => ({
  known: false,
  reason,
  detail,
});

export interface UnavailableField {
  /** Stable id, for a UI that wants to place these next to specific rows. */
  field: string;
  label: string;
  /** Why it cannot be known. Written to be shown to a user as-is. */
  why: string;
}

/**
 * What Baton cannot tell you about an account, and why.
 *
 * These were checked against the on-disk state, not assumed. Nothing here is
 * estimated, scraped or inferred, and no code path in this module produces a
 * number for any of them. Export it so the UI can say what is missing rather
 * than rendering an empty field that reads as a failure.
 */
export const UNAVAILABLE_FIELDS: readonly UnavailableField[] = [
  {
    field: 'plan',
    label: 'Plan',
    why: 'No local file records which plan an account is on. It is only visible to an authenticated API call, and Baton never reads credentials.',
  },
  {
    field: 'creditBalance',
    label: 'Credit balance',
    why: 'Nothing on disk carries a balance. The config directory holds settings and history, not billing state.',
  },
  {
    field: 'renewalDate',
    label: 'Renewal date',
    why: 'Billing dates live with the provider, not in the config directory.',
  },
  {
    field: 'usageAgainstLimit',
    label: 'Usage against the limit',
    why: 'No local file counts how much of a usage window has been consumed. policy-limits.json holds policy restrictions, not usage — that was checked. The only local signal is the provider saying in a transcript that the limit is already hit, which is what the spent state below is built from.',
  },
] as const;

/** Overall verdict. `draft` is an account directory that has never been signed in. */
export type HealthStatus = 'ok' | 'spent' | 'draft' | 'unknown';

export interface LiveSessionSummary {
  count: number;
  /** Editors the live sessions are running in, deduped. */
  editors: string[];
}

export interface SpentState {
  /** The limit message as the provider worded it. */
  message: string;
  /** Reset text in the provider's own words, e.g. "7:40pm (America/New_York)". */
  resets: Field<string>;
  /** ISO timestamp of the limit event. */
  at: string;
  /** How the event was tied to this account. */
  confidence: AttributionConfidence;
}

export interface AccountHealth {
  accountId: string;
  providerId: string;
  label: string;
  configDir: string;
  email?: string;

  status: HealthStatus;
  /** One line, safe to show as-is. Always explains the status. */
  reason: string;

  /** The current limit state, or a reason there is none to show. */
  spent: Field<SpentState>;
  /** The most recent attributed limit event, ISO. Independent of whether it still bites. */
  lastLimitAt: Field<string>;

  liveSessions: Field<LiveSessionSummary>;
  /** Newest activity attributable to this account, ISO. */
  lastUsedAt: Field<string>;
  /** Labels of hosts currently pointed at this account's config directory. */
  boundEditors: string[];

  /**
   * Limit events in the window that could not be tied to any account, because
   * the history they came from predates session recording. While this is above
   * zero, "no limit for this account" is not the same as "this account is fine".
   */
  unattributedLimits: number;

  /** Fields nothing local can answer. Same list for every account; carried here so a row can render it. */
  unavailable: readonly UnavailableField[];
}

export interface HealthOptions {
  /** Injectable for tests and for a caller that already polled. */
  sessions?: LiveSession[];
  limits?: LimitEvent[];
  hosts?: Host[];
  /**
   * How far back a limit event still counts as biting. Defaults to five hours,
   * the length of a Claude usage window, so an older event has certainly reset.
   *
   * The exact reset time is not derived from this: it is carried through as the
   * provider's own wording. Re-parsing "7:40pm (America/New_York)" into a
   * timestamp would invent a date the message never stated.
   */
  spentWindowMinutes?: number;
  /** Clock override, for tests. */
  now?: number;
}

const DEFAULT_SPENT_WINDOW_MINUTES = 5 * 60;

/** Newest mtime anywhere under a projects root, one level of project dirs deep. */
function newestTranscript(root: string): { at: number; sessions: Map<string, number> } {
  const sessions = new Map<string, number>();
  let at = 0;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return { at, sessions };
  }

  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(root, dir, name)).mtimeMs;
      } catch {
        continue;
      }
      sessions.set(name.slice(0, -'.jsonl'.length), mtimeMs);
      if (mtimeMs > at) at = mtimeMs;
    }
  }
  return { at, sessions };
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Where this account's own history lives, and whether it is the pooled store. */
function historyRoot(
  provider: Provider,
  account: Account,
  pooledRoot: string | null,
): { root: string; pooled: boolean } {
  const own = provider.resolveFile
    ? provider.resolveFile(account, 'projects')
    : path.join(account.configDir, 'projects');
  const real = realpath(own);
  return { root: own, pooled: real !== null && pooledRoot !== null && real === pooledRoot };
}

const uniq = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/**
 * Health for every account of one provider.
 *
 * Limit events come from the pooled history, which does not record which
 * account wrote it, so each one is put through attribution before it is blamed
 * on anybody. An event that cannot be attributed is counted but never assigned:
 * it turns the untouched accounts' status to 'unknown', which is the honest
 * answer, rather than being silently dropped or pinned on the wrong account.
 */
export function accountHealth(
  provider: Provider,
  accounts: Account[],
  opts: HealthOptions = {},
): AccountHealth[] {
  const windowMinutes = opts.spentWindowMinutes ?? DEFAULT_SPENT_WINDOW_MINUTES;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowMinutes * 60_000;

  const hosts = opts.hosts ?? safely(() => provider.discoverHosts(), []);
  const sessions = (opts.sessions ?? safely(() => findLiveSessions([provider], accounts), [])).filter(
    (s) => s.providerId === provider.id,
  );
  const limits = (opts.limits ?? safely(() => findLimitEvents([provider], { sinceMinutes: windowMinutes }), []))
    .filter((e) => e.providerId === provider.id)
    .sort((a, b) => b.at.localeCompare(a.at));

  const pooledProjects = path.join(sharedStore(provider.id), 'projects');
  const storePresent = exists(pooledProjects);
  const pooledReal = realpath(pooledProjects);
  const pooled = storePresent ? newestTranscript(pooledProjects) : { at: 0, sessions: new Map<string, number>() };

  const records = listAttributions().filter((r) => r.providerId === provider.id);

  // Attribute every limit event once, rather than per account.
  const limitsByAccount = new Map<string, { event: LimitEvent; confidence: AttributionConfidence }[]>();
  let unattributedLimits = 0;
  for (const event of limits) {
    const who = resolveAttribution(event.sessionId, { cwd: event.cwd, at: event.at });
    if (!who) {
      unattributedLimits++;
      continue;
    }
    const list = limitsByAccount.get(who.accountId) ?? [];
    list.push({ event, confidence: who.confidence });
    limitsByAccount.set(who.accountId, list);
  }

  return accounts
    .filter((a) => a.providerId === provider.id)
    .map((account) => {
      const mySessions = sessions.filter((s) => s.accountId === account.id);
      const myLimits = limitsByAccount.get(account.id) ?? [];
      const biting = myLimits.find(({ event }) => !event.at || Date.parse(event.at) >= cutoff);

      const boundEditors = hosts
        .filter((h) =>
          h.configDir
            ? path.resolve(h.configDir) === path.resolve(account.configDir)
            : account.isDefault,
        )
        .map((h) => h.label);

      const { root: ownRoot, pooled: sharesPool } = historyRoot(provider, account, pooledReal);

      const status = resolveStatus(account, biting !== undefined, unattributedLimits, storePresent);

      return {
        accountId: account.id,
        providerId: provider.id,
        label: account.label,
        configDir: account.configDir,
        ...(account.email ? { email: account.email } : {}),

        status,
        reason: reasonFor(status, {
          account,
          biting,
          live: mySessions.length,
          unattributedLimits,
          storePresent,
          windowMinutes,
        }),

        spent: spentField(biting, storePresent, windowMinutes),
        lastLimitAt: myLimits[0]
          ? knownField(myLimits[0].event.at, `limit message in transcript ${myLimits[0].event.sessionId}`)
          : storePresent
            ? unknownField<string>('not-applicable', `No limit event attributed to this account in the last ${windowMinutes} minutes.`)
            : unknownField<string>('not-recorded', 'No pooled history to scan, so nothing here says whether this account has hit a limit.'),

        liveSessions:
          process.platform === 'win32'
            ? unknownField<LiveSessionSummary>('unsupported', 'Live session detection reads the process table through ps, which is not wired up on Windows.')
            : knownField(
                { count: mySessions.length, editors: uniq(mySessions.map((s) => s.editorHint ?? s.entrypoint)) },
                'running processes with this account\'s config directory in their environment',
              ),

        lastUsedAt: lastUsedField(account.id, records, pooled.sessions, sharesPool ? null : ownRoot),
        boundEditors,
        unattributedLimits,
        unavailable: UNAVAILABLE_FIELDS,
      } satisfies AccountHealth;
    });
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * An account directory with no identity in it has never been signed in. That is
 * a draft, not a broken account, and its next action is a login rather than a
 * diagnosis.
 */
const isDraft = (account: Account): boolean => !account.email;

function resolveStatus(
  account: Account,
  biting: boolean,
  unattributedLimits: number,
  storePresent: boolean,
): HealthStatus {
  if (isDraft(account)) return 'draft';
  if (biting) return 'spent';
  // Absence of evidence is only evidence of health when the evidence could have
  // been there: no store means nothing was scanned, and an unattributed limit
  // means some account is spent and this one has not been ruled out.
  if (!storePresent || unattributedLimits > 0) return 'unknown';
  return 'ok';
}

function reasonFor(
  status: HealthStatus,
  ctx: {
    account: Account;
    biting?: { event: LimitEvent; confidence: AttributionConfidence };
    live: number;
    unattributedLimits: number;
    storePresent: boolean;
    windowMinutes: number;
  },
): string {
  const live = ctx.live === 1 ? '1 live session' : `${ctx.live} live sessions`;

  switch (status) {
    case 'draft':
      return 'Never signed in — the directory exists but holds no account identity yet.';
    case 'spent': {
      const when = ctx.biting?.event.resets ? `, resets ${ctx.biting.event.resets}` : '';
      const how = ctx.biting?.confidence === 'inferred' ? ' (matched by working directory and time)' : '';
      return `Limit hit${when}${how}.`;
    }
    case 'unknown':
      if (!ctx.storePresent) {
        return 'No pooled history on disk to check, so nothing here shows whether this account is spent.';
      }
      return `A limit was hit in the last ${ctx.windowMinutes} minutes, but the history it came from does not record which account produced it, so this one cannot be ruled out.`;
    default:
      return ctx.live > 0
        ? `No limit hit in the last ${ctx.windowMinutes} minutes; ${live}.`
        : `No limit hit in the last ${ctx.windowMinutes} minutes.`;
  }
}

function spentField(
  biting: { event: LimitEvent; confidence: AttributionConfidence } | undefined,
  storePresent: boolean,
  windowMinutes: number,
): Field<SpentState> {
  if (!biting) {
    return storePresent
      ? unknownField<SpentState>('not-applicable', `No limit event attributed to this account in the last ${windowMinutes} minutes.`)
      : unknownField<SpentState>('not-recorded', 'No pooled history to scan for limit messages.');
  }

  return knownField(
    {
      message: biting.event.message,
      at: biting.event.at,
      confidence: biting.confidence,
      resets: biting.event.resets
        ? knownField(biting.event.resets, 'the provider\'s own wording in the limit message')
        : unknownField<string>('not-recorded', 'The limit message did not name a reset time.'),
    },
    biting.confidence === 'exact'
      ? `limit message in transcript ${biting.event.sessionId}, which was recorded running under this account`
      : `limit message in transcript ${biting.event.sessionId}, matched to this account by working directory and time`,
  );
}

/**
 * When this account was last used.
 *
 * Three sources, in descending order of directness: a transcript we recorded
 * this account writing, the moment we watched a session of it running, and —
 * for an account that has not been linked into the pooled store — its own
 * private history, which is all its own by definition.
 *
 * Pooled history with no attribution record gives nothing. That is the whole
 * shape of the retroactive problem and it is reported, not filled in.
 */
function lastUsedField(
  accountId: string,
  records: ReturnType<typeof listAttributions>,
  pooledSessions: Map<string, number>,
  ownRoot: string | null,
): Field<string> {
  let best = 0;
  let source = '';

  for (const r of records) {
    if (r.accountId !== accountId) continue;

    const transcript = r.sessionId ? pooledSessions.get(r.sessionId) : undefined;
    if (transcript !== undefined && transcript > best) {
      best = transcript;
      source = `newest transcript recorded under this account (session ${r.sessionId})`;
    }

    const seen = Date.parse(r.lastSeen);
    if (Number.isFinite(seen) && seen > best) {
      best = seen;
      source = 'a session observed running under this account';
    }
  }

  if (ownRoot) {
    const own = newestTranscript(ownRoot).at;
    if (own > best) {
      best = own;
      source = 'newest transcript in this account\'s own history, which is not pooled';
    }
  }

  if (!best) {
    return unknownField<string>(
      'not-recorded',
      'History is pooled across accounts and transcripts never recorded which account wrote them, so nothing before Baton started watching sessions can be attributed. This fills in once a session of this account has been seen running.',
    );
  }
  return knownField(new Date(best).toISOString(), source);
}
