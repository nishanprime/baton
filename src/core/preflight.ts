import fs from 'node:fs';
import path from 'node:path';
import { appHome, backupsPath, sharedStore, exists, isDir, isSymlink } from './paths.ts';
import { PROVIDERS } from './registry.ts';
import { findLiveSessions, type LiveSession } from './sessions.ts';
import type { Account, Host, Provider } from './types.ts';

/**
 * Everything Baton can learn about this machine without touching it.
 *
 * Setup, the GUI's first run and `baton doctor` all used to ask their own
 * questions in their own order and reach different conclusions. This is the one
 * pass they share: it reads, it never writes, it never prompts, and it hands
 * back a structure that each of them renders however it likes.
 */

/** Matches the engines field in package.json. */
export const REQUIRED_NODE = '22.18.0';

export type ProblemLevel = 'blocker' | 'warning';

export interface PreflightProblem {
  level: ProblemLevel;
  /** Stable identifier so a UI can key off it instead of matching on prose. */
  code: string;
  message: string;
  /** What the user should do about it, in plain words. */
  action: string;
  /** The command that does it, when one command does. */
  command?: string;
  providerId?: string;
  hostId?: string;
  accountId?: string;
}

export interface NodeCheck {
  version: string;
  required: string;
  ok: boolean;
}

/** How a provider was found. 'unknown' means it declined to say. */
export type InstallKind = 'cli' | 'extension' | 'both' | 'none' | 'unknown';

export interface AccountReport {
  id: string;
  label: string;
  configDir: string;
  email: string | null;
  isDefault: boolean;
  /** Directory exists but nothing ever logged into it. The dead-draft case. */
  draft: boolean;
  /** Shared entries pointing at the store, out of those the account has. */
  pooling: { state: 'none' | 'partial' | 'full'; linked: number; present: number; unlinked: string[] };
  /** Host ids currently bound to this account. */
  usedBy: string[];
  /** Sessions running against this account's config dir right now. */
  liveSessions: LiveSession[];
}

export interface HostReport {
  id: string;
  label: string;
  configFile: string;
  configDir: string | null;
  /** Account the config dir resolves to, or null when it points somewhere unknown. */
  accountId: string | null;
  inconsistent: boolean;
  extensionInstalled: boolean | null;
  extensionVersion: string | null;
  /** Sessions whose binary was launched from this editor. */
  liveSessions: LiveSession[];
}

export interface ProviderReport {
  id: string;
  label: string;
  envVar: string;
  /** Binary name to put in front of a user-facing command. */
  processName: string;
  installed: boolean;
  via: InstallKind;
  /** Where it was found, as the provider worded it. */
  detail: string;
  cliPath: string | null;
  accounts: AccountReport[];
  hosts: HostReport[];
  sessions: LiveSession[];
  history: {
    store: string;
    exists: boolean;
    state: 'none' | 'partial' | 'pooled';
    pooledAccounts: number;
    totalAccounts: number;
  };
}

export interface BackupsReport {
  path: string;
  exists: boolean;
  snapshots: number;
  bytes: number;
  newestAt: string | null;
  /** False when the walk hit its budget, so `bytes` is a lower bound. */
  complete: boolean;
}

export interface PreflightReport {
  generatedAt: string;
  platform: NodeJS.Platform;
  appHome: string;
  node: NodeCheck;
  providers: ProviderReport[];
  /** Providers believed to be present. Setup walks these, not just the first. */
  installedProviders: ProviderReport[];
  /** Editors found across every provider, deduplicated by id. */
  editorCount: number;
  /** False on win32, where session discovery is not implemented. */
  sessionsSupported: boolean;
  sessions: LiveSession[];
  /** Live sessions that could not be attributed to an editor — terminal ones, usually. */
  unattributedSessions: LiveSession[];
  backups: BackupsReport;
  blockers: PreflightProblem[];
  warnings: PreflightProblem[];
  /** No blockers. Warnings can still be present. */
  ok: boolean;
}

export interface PreflightOptions {
  /** Defaults to the whole registry. */
  providers?: Provider[];
  /** Skip the `ps` scan, which is the only part that shells out. */
  skipSessions?: boolean;
  skipBackups?: boolean;
}

// ------------------------------------------------------------------ helpers

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** First match for a bare binary name on PATH, honouring PATHEXT on Windows. */
export function binaryOnPath(bin: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Which shared entries of one account already point at the store.
 *
 * Counted against what the account actually has rather than the whole policy,
 * or an account that never used plans/ or skills/ would read as half-pooled
 * forever.
 */
function poolingFor(provider: Provider, account: Account): AccountReport['pooling'] {
  const store = sharedStore(provider.id);
  const unlinked: string[] = [];
  let linked = 0;
  let present = 0;

  for (const entry of provider.sharePolicy.shared) {
    const src = path.join(account.configDir, entry);
    if (!exists(src)) continue;
    present++;

    if (isSymlink(src)) {
      const target = (() => {
        try {
          return fs.readlinkSync(src);
        } catch {
          return '';
        }
      })();
      if (target && path.resolve(target) === path.resolve(path.join(store, entry))) {
        linked++;
        continue;
      }
    }
    unlinked.push(entry);
  }

  const state = linked === 0 ? 'none' : linked === present ? 'full' : 'partial';
  return { state, linked, present, unlinked };
}

const EDITOR_ALIASES: Record<string, string> = {
  code: 'vscode',
  'code - insiders': 'vscode-insiders',
  'visual studio code': 'vscode',
  'visual studio code - insiders': 'vscode-insiders',
  'code - oss': 'vscodium',
  'vscode-oss': 'vscodium',
  'trae ai': 'trae',
};

/** Editor names reach us from two places — an extension path and an .app bundle. */
function normalizeEditor(hint: string): string {
  const key = hint.trim().toLowerCase();
  return EDITOR_ALIASES[key] ?? key.replace(/\s+/g, '-');
}

function hostKeys(host: Host): string[] {
  const label = host.label.toLowerCase();
  return [host.id, label.replace(/\s+/g, '-'), label.replace(/\s+/g, '')];
}

function sessionIsOn(host: Host, session: LiveSession): boolean {
  if (!session.editorHint) return false;
  const hint = normalizeEditor(session.editorHint);
  return hostKeys(host).includes(hint) || hostKeys(host).includes(hint.replace(/-/g, ''));
}

/**
 * Size and age of the backups tree, on a budget.
 *
 * Backups are the undo for everything Baton writes, so their health is worth
 * reporting — but this runs before an interactive prompt, so it walks a bounded
 * number of entries and admits when it stopped early rather than stat-ing a
 * tree that has been growing since install.
 */
function inspectBackups(): BackupsReport {
  const dir = backupsPath();
  const empty: BackupsReport = {
    path: dir,
    exists: false,
    snapshots: 0,
    bytes: 0,
    newestAt: null,
    complete: true,
  };
  if (!isDir(dir)) return empty;

  let snapshots = 0;
  let newestMs = 0;
  let tops: fs.Dirent[];
  try {
    tops = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ...empty, exists: true };
  }

  const stack: string[] = [];
  for (const t of tops) {
    if (!t.isDirectory()) continue;
    snapshots++;
    const full = path.join(dir, t.name);
    stack.push(full);
    try {
      newestMs = Math.max(newestMs, fs.statSync(full).mtimeMs);
    } catch {
      /* a snapshot that vanished mid-walk is not worth failing over */
    }
  }

  let budget = 25_000;
  let bytes = 0;
  let complete = true;

  while (stack.length) {
    if (budget <= 0) {
      complete = false;
      break;
    }
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      budget--;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }

  return {
    path: dir,
    exists: true,
    snapshots,
    bytes,
    newestAt: newestMs ? new Date(newestMs).toISOString() : null,
    complete,
  };
}

/** Bytes past which the backups tree is worth mentioning. */
const BACKUP_NAG_BYTES = 500 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

// ------------------------------------------------------------------ the pass

export function preflight(opts: PreflightOptions = {}): PreflightReport {
  const providers = opts.providers ?? PROVIDERS;

  const node: NodeCheck = {
    version: process.versions.node,
    required: REQUIRED_NODE,
    ok: compareVersions(process.versions.node, REQUIRED_NODE) >= 0,
  };

  // Discover once, then answer every question from the same snapshot — two
  // passes over a directory that is being written to disagree with each other.
  const discovered = providers.map((provider) => ({
    provider,
    accounts: provider.discoverAccounts(),
    hosts: provider.discoverHosts(),
  }));

  const sessionsSupported = process.platform !== 'win32';
  const allAccounts = discovered.flatMap((d) => d.accounts);
  const sessions =
    opts.skipSessions || !sessionsSupported ? [] : findLiveSessions(providers, allAccounts);

  const reports: ProviderReport[] = discovered.map(({ provider, accounts, hosts }) => {
    const declared = provider.isInstalled?.();
    const cliPath = binaryOnPath(provider.processName ?? provider.id);
    const viaExtension = hosts.some((h) => h.extensionInstalled === true);

    // A provider that does not implement isInstalled cannot be ruled out, so
    // it is treated as present rather than silently dropped from setup.
    const installed = declared ? declared.installed : true;

    const via: InstallKind =
      cliPath && viaExtension
        ? 'both'
        : cliPath
          ? 'cli'
          : viaExtension
            ? 'extension'
            : // It says it is here but we cannot see how; its own detail is the
              // better answer than a flat "not installed".
              installed
              ? 'unknown'
              : 'none';
    const mySessions = sessions.filter((s) => s.providerId === provider.id);

    const accountReports: AccountReport[] = accounts.map((a) => ({
      id: a.id,
      label: a.label,
      configDir: a.configDir,
      email: a.email ?? null,
      isDefault: a.isDefault,
      draft: !a.email,
      pooling: poolingFor(provider, a),
      usedBy: hosts.filter((h) => h.configDir === a.configDir).map((h) => h.id),
      liveSessions: mySessions.filter(
        (s) => s.configDir === path.resolve(a.configDir) || s.accountId === a.id,
      ),
    }));

    const hostReports: HostReport[] = hosts.map((h) => ({
      id: h.id,
      label: h.label,
      configFile: h.configFile,
      configDir: h.configDir ?? null,
      accountId: accounts.find((a) => a.configDir === h.configDir)?.id ?? null,
      inconsistent: h.inconsistent,
      extensionInstalled: h.extensionInstalled ?? null,
      extensionVersion: h.extensionVersion ?? null,
      liveSessions: mySessions.filter((s) => sessionIsOn(h, s)),
    }));

    const store = sharedStore(provider.id);
    const pooledAccounts = accountReports.filter((a) => a.pooling.state === 'full').length;
    const anyPooled = accountReports.some((a) => a.pooling.state !== 'none');

    return {
      id: provider.id,
      label: provider.label,
      envVar: provider.envVar,
      processName: provider.processName ?? provider.id,
      installed,
      via,
      detail: declared?.detail ?? 'this provider does not report how it was installed',
      cliPath,
      accounts: accountReports,
      hosts: hostReports,
      sessions: mySessions,
      history: {
        store,
        exists: exists(store),
        state:
          accountReports.length && pooledAccounts === accountReports.length
            ? 'pooled'
            : anyPooled
              ? 'partial'
              : 'none',
        pooledAccounts,
        totalAccounts: accountReports.length,
      },
    };
  });

  const installedProviders = reports.filter((r) => r.installed);
  const backups = opts.skipBackups
    ? { path: backupsPath(), exists: false, snapshots: 0, bytes: 0, newestAt: null, complete: true }
    : inspectBackups();

  const editorIds = new Set(installedProviders.flatMap((r) => r.hosts.map((h) => h.id)));
  const attributed = new Set(
    installedProviders.flatMap((r) => r.hosts.flatMap((h) => h.liveSessions.map((s) => s.pid))),
  );

  const report: PreflightReport = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    appHome: appHome(),
    node,
    providers: reports,
    installedProviders,
    editorCount: editorIds.size,
    sessionsSupported,
    sessions,
    unattributedSessions: sessions.filter((s) => !attributed.has(s.pid)),
    backups,
    blockers: [],
    warnings: [],
    ok: true,
  };

  const problems = findProblems(report);
  report.blockers = problems.filter((p) => p.level === 'blocker');
  report.warnings = problems.filter((p) => p.level === 'warning');
  report.ok = report.blockers.length === 0;
  return report;
}

/**
 * Turn the findings into things to do.
 *
 * Blockers stop Baton working at all; everything else is advisory, because a
 * half-configured machine is still a usable one and refusing to continue is how
 * setup used to dead-end.
 */
function findProblems(report: PreflightReport): PreflightProblem[] {
  const out: PreflightProblem[] = [];

  if (!report.node.ok) {
    out.push({
      level: 'blocker',
      code: 'node-too-old',
      message: `Node ${report.node.version} is older than the required ${report.node.required}.`,
      action: 'Baton runs TypeScript directly, which needs Node 22.18 or newer. Upgrade Node, then run setup again.',
    });
  }

  if (!report.installedProviders.length) {
    out.push({
      level: 'blocker',
      code: 'no-provider',
      message: 'No supported AI coding CLI was found on this machine.',
      action:
        'Install Claude Code — as a CLI on your PATH, or as the editor extension — then run setup again. Baton switches between accounts of a CLI you already have; it does not install one.',
    });
  }

  if (report.installedProviders.length && report.editorCount === 0) {
    out.push({
      level: 'warning',
      code: 'no-editors',
      message: 'No supported editor was found.',
      action:
        'Nothing is broken: Baton works from the terminal alone by exporting the config-dir variable in your shell. Setup will walk you through it. Editors Baton knows about: VS Code, VS Code Insiders, Cursor, Antigravity, Windsurf, VSCodium and Trae.',
    });
  }

  if (!report.sessionsSupported) {
    out.push({
      level: 'warning',
      code: 'sessions-unsupported',
      message: 'Running sessions cannot be detected on Windows yet.',
      action:
        'Close your editor windows before switching accounts, since Baton cannot warn you about a session that is still holding old credentials.',
    });
  }

  for (const p of report.installedProviders) {
    if (!p.accounts.length) {
      out.push({
        level: 'warning',
        code: 'no-accounts',
        message: `${p.label}: no account directories found.`,
        action: 'Create one and log into it. Baton needs at least two to switch between.',
        command: 'baton add work',
        providerId: p.id,
      });
    } else if (p.accounts.length === 1) {
      out.push({
        level: 'warning',
        code: 'single-account',
        message: `${p.label}: only one account (${p.accounts[0]!.id}).`,
        action: 'Add a second one — switching needs somewhere to switch to.',
        command: 'baton add work',
        providerId: p.id,
      });
    }

    for (const a of p.accounts.filter((x) => x.draft)) {
      out.push({
        level: 'warning',
        code: 'draft-account',
        message: `${a.id}: the directory exists but nothing has logged into it.`,
        action:
          'Log in, or the account is a dead end that editors can be pointed at but cannot use.',
        command: `${p.envVar}="${a.configDir}" ${p.cliPath ? path.basename(p.cliPath) : p.id}`,
        providerId: p.id,
        accountId: a.id,
      });
    }

    for (const h of p.hosts) {
      if (h.inconsistent) {
        out.push({
          level: 'warning',
          code: 'host-inconsistent',
          message: `${h.label}: the extension and terminal settings for ${p.envVar} disagree.`,
          action: 'Rebind the editor so both keys match. A half-applied switch is the usual cause.',
          command: `baton use <account> --host ${h.id}`,
          providerId: p.id,
          hostId: h.id,
        });
      }
      if (h.configDir && !h.accountId) {
        out.push({
          level: 'warning',
          code: 'host-unknown-dir',
          message: `${h.label} points at ${h.configDir}, which is not a recognised account.`,
          action: 'Point it at a known account, or check the directory still exists.',
          command: `baton use <account> --host ${h.id}`,
          providerId: p.id,
          hostId: h.id,
        });
      }
      if (h.extensionInstalled === false) {
        out.push({
          level: 'warning',
          code: 'extension-missing',
          message: `${h.label}: the ${p.label} extension is not installed.`,
          action:
            'Baton can still set the variable for the integrated terminal there, but the extension panel will not be around to use it.',
          providerId: p.id,
          hostId: h.id,
        });
      }
    }

    if (p.accounts.length > 1 && p.history.state !== 'pooled') {
      out.push({
        level: 'warning',
        code: 'history-not-pooled',
        message:
          p.history.state === 'partial'
            ? `${p.label}: history is pooled for ${p.history.pooledAccounts} of ${p.history.totalAccounts} accounts.`
            : `${p.label}: each account still keeps its own separate history.`,
        action:
          'Pool it so every account resumes the same conversations. Everything is backed up first, and `baton unlink` puts it back.',
        command: 'baton link --all',
        providerId: p.id,
      });
    }

    if (p.sessions.length) {
      const where = p.sessions
        .map((s) => s.accountId ?? 'an unknown account')
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(', ');
      out.push({
        level: 'warning',
        code: 'live-sessions',
        message: `${p.sessions.length} ${p.label} session(s) running right now, on ${where}.`,
        action:
          'A running session read its credentials at startup, so switching will not affect it until that window is reloaded. Finish or reload them before switching.',
        providerId: p.id,
      });
    }
  }

  if (report.backups.bytes > BACKUP_NAG_BYTES) {
    out.push({
      level: 'warning',
      code: 'backups-large',
      message: `Backups are using ${formatBytes(report.backups.bytes)}${report.backups.complete ? '' : ' or more'} across ${report.backups.snapshots} snapshots.`,
      action: `Old snapshots under ${report.backups.path} can be deleted once you are happy with how things look. Baton never deletes them for you.`,
    });
  }

  return out;
}

// ------------------------------------------------------------------ rendering

const ANSI = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const plain = (s: string) => s;

/**
 * The report as lines of text, for whoever wants to print it.
 *
 * Returned rather than logged so setup, doctor and a test can each decide where
 * it goes.
 */
export function renderPreflight(
  report: PreflightReport,
  opts: { color?: boolean; showProblems?: boolean } = {},
): string[] {
  const c = opts.color === false
    ? { bold: plain, dim: plain, green: plain, yellow: plain, red: plain, cyan: plain }
    : ANSI;
  const lines: string[] = [];

  lines.push(
    `${c.bold('This machine')}  ${c.dim(`${report.platform} · node ${report.node.version} · state in ${report.appHome}`)}`,
  );
  if (!report.node.ok) lines.push(`  ${c.red('✗')} node ${report.node.required} or newer is required`);

  for (const p of report.providers) {
    const mark = p.installed ? c.green('•') : c.yellow('•');
    lines.push(`\n${mark} ${c.bold(p.label)}  ${c.dim(p.detail)}`);

    lines.push(`  ${c.bold('Accounts')}`);
    if (!p.accounts.length) lines.push(`    ${c.dim('none yet')}`);
    for (const a of p.accounts) {
      const who = a.draft ? c.yellow('not logged in') : c.dim(a.email ?? '');
      const pooled =
        a.pooling.state === 'full'
          ? c.dim(' · history pooled')
          : a.pooling.state === 'partial'
            ? c.yellow(' · history partly pooled')
            : c.dim(' · own history');
      const busy = a.liveSessions.length ? c.yellow(` · ${a.liveSessions.length} running`) : '';
      lines.push(`    ${c.bold(a.id.padEnd(14))} ${who}${pooled}${busy}`);
    }

    lines.push(`  ${c.bold('Editors')}`);
    if (!p.hosts.length) lines.push(`    ${c.dim('none found — terminal use works fine')}`);
    for (const h of p.hosts) {
      const bound = h.accountId
        ? c.green(h.accountId)
        : h.configDir
          ? c.yellow('unrecognised dir')
          : c.dim('default account');
      const ext =
        h.extensionInstalled === false
          ? c.yellow(' · no extension')
          : h.extensionVersion
            ? c.dim(` · ext ${h.extensionVersion}`)
            : '';
      const busy = h.liveSessions.length ? c.yellow(` · ${h.liveSessions.length} running`) : '';
      lines.push(`    ${h.label.padEnd(14)} ${bound}${ext}${busy}`);
    }

    const hist =
      p.history.state === 'pooled'
        ? c.green('shared by every account')
        : p.history.state === 'partial'
          ? c.yellow(`shared by ${p.history.pooledAccounts} of ${p.history.totalAccounts}`)
          : c.dim('separate per account');
    lines.push(`  ${c.bold('History')}  ${hist} ${c.dim(p.history.store)}`);
  }

  if (report.unattributedSessions.length) {
    lines.push(
      `\n${c.dim(`${report.unattributedSessions.length} running session(s) not tied to an editor — terminal, most likely.`)}`,
    );
  }
  if (report.backups.exists) {
    lines.push(
      c.dim(
        `Backups: ${report.backups.snapshots} snapshots, ${formatBytes(report.backups.bytes)}${report.backups.complete ? '' : '+'} in ${report.backups.path}`,
      ),
    );
  }

  if (opts.showProblems === false) return lines;

  for (const b of report.blockers) {
    lines.push(`\n${c.red('✗')} ${c.bold(b.message)}`);
    lines.push(`  ${b.action}`);
    if (b.command) lines.push(`  ${c.cyan(b.command)}`);
  }
  for (const w of report.warnings) {
    lines.push(`\n${c.yellow('!')} ${w.message}`);
    lines.push(`  ${c.dim(w.action)}`);
    if (w.command) lines.push(`  ${c.cyan(w.command)}`);
  }
  if (report.ok && !report.warnings.length) lines.push(`\n${c.green('✓ nothing to fix.')}`);

  return lines;
}
