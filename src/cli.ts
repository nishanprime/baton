#!/usr/bin/env node
import { PROVIDERS, getProvider, defaultProvider } from './core/registry.ts';
import { linkAccount, unlinkAccount } from './core/share.ts';
import { switchHost } from './core/switch.ts';
import { appHome, sharedStore } from './core/paths.ts';
import { runSetup, createAccount, loginHint } from './core/setup.ts';
import { loadSettings, setSetting, setAlias, settingsPath, SCHEMA } from './core/settings.ts';
import { accountLabel, accountEmail, makeProjectMasker, maskPath, maskPathsInText } from './core/display.ts';
import { listConversations, historyFacets } from './core/history.ts';
import { findLimitEvents } from './core/limits.ts';
import { loadState, saveState } from './core/state.ts';
import type { Account, Host, Provider } from './core/types.ts';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const asJson = flags.has('--json');

const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dim = (s: string) => (asJson ? s : `\x1b[2m${s}\x1b[0m`);
const bold = (s: string) => (asJson ? s : `\x1b[1m${s}\x1b[0m`);
const green = (s: string) => (asJson ? s : `\x1b[32m${s}\x1b[0m`);
const yellow = (s: string) => (asJson ? s : `\x1b[33m${s}\x1b[0m`);

/** Machine-readable output for the GUI, which drives this CLI. */
const emit = (payload: unknown): void => console.log(JSON.stringify(payload, null, 2));

const resolveProvider = (): Provider => {
  const id = flagValue('--provider');
  return id ? getProvider(id) : defaultProvider();
};

function findAccount(accounts: Account[], key: string): Account {
  const hit = accounts.find((a) => a.id === key || a.configDir === key || a.email === key);
  if (!hit) {
    throw new Error(
      `No account "${key}". Known: ${accounts.map((a) => a.id).join(', ') || '(none found)'}`,
    );
  }
  return hit;
}

// ---------------------------------------------------------------- status

function cmdStatus(): void {
  const settings = loadSettings();
  const data = PROVIDERS.map((provider) => {
    const accounts = provider.discoverAccounts();
    const hosts = provider.discoverHosts();
    return { provider, accounts, hosts };
  });

  if (asJson) {
    emit({
      appHome: appHome(),
      settings,
      settingsPath: settingsPath(),
      providers: data.map(({ provider, accounts, hosts }) => ({
        id: provider.id,
        label: provider.label,
        envVar: provider.envVar,
        sharedStore: sharedStore(provider.id),
        accounts: accounts.map((a) => ({
          ...a,
          // displayName/displayEmail are what a UI should render; id and email
          // stay untouched so nothing keys off a cosmetic value.
          displayName: accountLabel(a.id, settings),
          displayEmail: accountEmail(a.email, settings),
          hasAlias: a.id in settings.display.aliases,
          displayDir: maskPath(a.configDir, settings),
          usedBy: hosts.filter((h) => h.configDir === a.configDir).map((h) => h.id),
        })),
        hosts: hosts.map((h) => ({
          ...h,
          accountId: accounts.find((a) => a.configDir === h.configDir)?.id ?? null,
        })),
      })),
    });
    return;
  }

  console.log(`${bold('Baton')} ${dim(`· state in ${appHome()}`)}\n`);
  for (const { provider, accounts, hosts } of data) {
    console.log(`${bold(provider.label)} ${dim(`(${provider.envVar})`)}`);
    console.log(`\n ${bold('Accounts')}`);
    if (!accounts.length) console.log(dim('  none found'));
    for (const a of accounts) {
      const users = hosts.filter((h) => h.configDir === a.configDir).map((h) => h.label);
      console.log(
        `  ${bold(accountLabel(a.id, settings).padEnd(16))}${dim(accountEmail(a.email, settings))}` +
          (users.length ? green(`  ← ${users.join(', ')}`) : ''),
      );
      console.log(`    ${dim(maskPath(a.configDir, settings))}`);
    }
    console.log(`\n ${bold('Editors')}`);
    if (!hosts.length) console.log(dim('  none found'));
    for (const h of hosts) {
      const acct = accounts.find((a) => a.configDir === h.configDir);
      const label = acct ? green(acct.id) : h.configDir ? yellow('unmanaged dir') : dim('default');
      const warn = h.inconsistent ? yellow('  ⚠ settings keys disagree — run `baton doctor`') : '';
      console.log(`  ${h.label.padEnd(18)} ${label}${warn}`);
    }
    console.log(`\n ${bold('Shared store')}  ${dim(sharedStore(provider.id))}\n`);
  }
}

// ---------------------------------------------------------------- use

function cmdUse(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const hosts = provider.discoverHosts();

  const key = positional[1];
  if (!key) throw new Error('Usage: baton use <account> [--host <id>|--all] [--dry-run]');
  const to = findAccount(accounts, key);

  const hostId = flagValue('--host');
  const targets = flags.has('--all')
    ? hosts
    : hostId
      ? hosts.filter((h) => h.id === hostId)
      : hosts.filter((h) => h.configDir);

  if (!targets.length) {
    throw new Error(`No matching editor. Known: ${hosts.map((h) => h.id).join(', ')}`);
  }

  const results = targets.map((host) => switchHost(provider, host, to, accounts, { dryRun }));

  if (asJson) {
    emit({
      ok: true,
      account: { id: to.id, email: to.email ?? null, configDir: to.configDir },
      switched: results.map((r) => ({
        host: r.host.id,
        label: r.host.label,
        from: r.from?.id ?? null,
        configFile: r.host.configFile,
      })),
      dryRun,
      note: dryRun ? null : 'Reload the editor window, then `claude --resume`.',
    });
    return;
  }

  for (const r of results) {
    const prefix = dryRun ? yellow('[dry-run]') : green('✓');
    console.log(`${prefix} ${r.host.label} → ${bold(to.id)}${to.email ? dim(` (${to.email})`) : ''}`);
    if (r.from) console.log(dim(`    carried project state forward from ${r.from.id}`));
  }
  if (!dryRun && loadSettings().showReloadHint) {
    console.log(`\n${yellow('Reload the editor window')} for the change to take effect.`);
    console.log(dim('Then `claude --resume` — your conversations are all still there.'));
  }
}

// ---------------------------------------------------------------- link

function cmdLink(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const key = positional[1];
  const targets = flags.has('--all') || !key ? accounts : [findAccount(accounts, key)];

  const storeState = new Map<string, string>();
  const report = targets.map((a) => ({
    account: a.id,
    configDir: a.configDir,
    actions: linkAccount(provider, a, { dryRun, storeState }).filter((x) => x.action !== 'skipped'),
  }));

  if (asJson) {
    emit({
      ok: true,
      dryRun,
      sharedStore: sharedStore(provider.id),
      lossy: report.flatMap((r) => r.actions).filter((a) => a.action === 'overwritten-by-store').length,
      accounts: report,
    });
    return;
  }

  for (const r of report) {
    console.log(`${bold(r.account)} ${dim(r.configDir)}`);
    for (const act of r.actions) {
      const mark =
        act.action === 'overwritten-by-store' ? yellow('!') : dryRun ? yellow('·') : green('✓');
      console.log(
        `  ${mark} ${act.entry.padEnd(18)} ${dim(act.action)}${act.detail ? dim(` — ${act.detail}`) : ''}`,
      );
    }
  }
  console.log(`\n${dim(`shared store: ${sharedStore(provider.id)}`)}`);
}

function cmdUnlink(): void {
  const provider = resolveProvider();
  const key = positional[1];
  if (!key) throw new Error('Usage: baton unlink <account> [--dry-run]');
  const a = findAccount(provider.discoverAccounts(), key);
  const actions = unlinkAccount(provider, a, { dryRun });
  if (asJson) return emit({ ok: true, account: a.id, dryRun, actions });
  for (const act of actions) console.log(`  ${act.entry.padEnd(18)} ${dim(act.detail ?? '')}`);
}

// ---------------------------------------------------------------- add

function cmdAdd(): void {
  const provider = resolveProvider();
  const name = positional[1];
  if (!name) throw new Error('Usage: baton add <name>');
  const dir = createAccount(provider, name);
  const command = loginHint(provider, dir);

  if (asJson) {
    return emit({
      ok: true,
      account: name,
      configDir: dir,
      loginCommand: command,
      next: 'Run the login command in a terminal, then /login inside that session.',
    });
  }
  console.log(`${green('✓')} Created ${dir}`);
  console.log(`\nLog into it with:\n  ${bold(command)}`);
  console.log(dim('Then run /login inside that session.'));
  console.log(dim(`\nAfterwards: baton link ${name} && baton use ${name} --all`));
}

// ---------------------------------------------------------------- settings

function cmdSettings(): void {
  const sub = positional[1];

  if (sub === 'set') {
    const [key, ...rest] = positional.slice(2);
    const raw = rest.join(' ') || flagValue('--value');
    if (!key || raw === undefined) throw new Error('Usage: baton settings set <key> <value>');
    const next = setSetting(key, raw);
    if (asJson) return emit({ ok: true, settings: next, path: settingsPath() });
    console.log(`${green('✓')} ${key} = ${JSON.stringify(getAt(next, key))}`);
    return;
  }

  const settings = loadSettings();
  if (asJson) return emit({ ok: true, settings, schema: SCHEMA, path: settingsPath() });

  console.log(`${bold('Settings')} ${dim(settingsPath())}\n`);
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const value = getAt(settings, key);
    console.log(`  ${bold(key.padEnd(24))} ${String(JSON.stringify(value)).padEnd(12)} ${dim(spec.help)}`);
  }
  console.log(`\n${dim('Change one with: baton settings set <key> <value>')}`);
}

function getAt(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], obj);
}

// ---------------------------------------------------------------- history

function cmdHistory(): void {
  const providerFlag = flagValue('--provider');
  const providers = providerFlag ? [getProvider(providerFlag)] : PROVIDERS;
  const limitRaw = flagValue('--limit');

  const offsetRaw = flagValue('--offset');
  const page = listConversations(providers, {
    project: flagValue('--project'),
    launchedFrom: flagValue('--from'),
    search: flagValue('--search'),
    limit: limitRaw ? Number(limitRaw) : 50,
    offset: offsetRaw ? Number(offsetRaw) : 0,
    withFacets: asJson,
  });

  const settings = loadSettings();
  const maskProject = settings.display.hideProjects;

  if (asJson) {
    const facets = page.facets ?? { projects: [], launchedFrom: [], providers: [] };
    const masker = makeProjectMasker(facets.projects.map((f) => f.value));
    const decorate = (c: (typeof page.conversations)[number]) => ({
      ...c,
      displayProject: maskProject ? masker(c.project) : c.project,
      displayTitle: maskPathsInText(c.title, settings),
      displayCwd: maskPath(c.cwd, settings),
    });
    return emit({
      ok: true,
      total: page.total,
      totalUnfiltered: page.totalUnfiltered,
      shown: page.conversations.length,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
      reparsed: page.reparsed,
      facets,
      conversations: page.conversations.map(decorate),
    });
  }

  const cliMasker = makeProjectMasker(page.conversations.map((c) => c.project));
  console.log(
    `${bold('Conversations')} ${dim(`${page.offset + 1}-${page.offset + page.conversations.length} of ${page.total}`)}\n`,
  );
  for (const c of page.conversations) {
    const when = c.updatedAt ? c.updatedAt.slice(0, 16).replace('T', ' ') : '';
    const proj = maskProject ? cliMasker(c.project) : c.project;
    console.log(`  ${dim(when)}  ${bold(proj.padEnd(18))} ${maskPathsInText(c.title, settings)}`);
    const size = `${(c.sizeBytes / 1048576).toFixed(1)}MB`;
    console.log(`  ${dim(`${' '.repeat(16)}  ${c.messages ?? '~'} msgs · ${size} · ${c.sessionId}`)}`);
  }
  if (!page.conversations.length) console.log(dim('  nothing matched'));
  if (page.hasMore) {
    console.log(dim(`\n  more: baton history --offset ${page.offset + page.conversations.length}`));
  }
}

// ---------------------------------------------------------------- alias

function cmdAlias(): void {
  const [id, ...rest] = positional.slice(1);
  if (!id) throw new Error('Usage: baton alias <account> <display name>   (empty name clears it)');

  const provider = resolveProvider();
  const account = findAccount(provider.discoverAccounts(), id);
  const alias = rest.join(' ').trim();
  const next = setAlias(account.id, alias || null);

  if (asJson) return emit({ ok: true, account: account.id, alias: alias || null, settings: next });
  console.log(
    alias
      ? `${green('✓')} ${account.id} now shows as ${bold(alias)}`
      : `${green('✓')} cleared the display name for ${bold(account.id)}`,
  );
  console.log(dim('Cosmetic only — the config directory and env var are unchanged.'));
}

// ---------------------------------------------------------------- autoswitch

/**
 * Check whether the active account is spent and act on it.
 *
 * Meant to be polled. State records the newest event already handled, so a
 * single exhaustion does not cause a switch on every poll.
 */
function cmdAutoswitch(): void {
  const settings = loadSettings();
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const hosts = provider.discoverHosts().filter((h) => h.configDir);
  const state = loadState();

  const windowMinutes = Number(flagValue('--since') ?? 30);
  const events = findLimitEvents([provider], { sinceMinutes: windowMinutes });
  const newest = events[0];
  const isNew = !!newest && newest.at !== state.lastHandledLimitAt;

  // Accounts currently in use are the ones that just hit the wall.
  const activeIds = new Set(
    hosts.map((h) => accounts.find((a) => a.configDir === h.configDir)?.id).filter(Boolean) as string[],
  );
  const rotation = settings.autoSwitch.rotation.length
    ? settings.autoSwitch.rotation
    : accounts.filter((a) => !a.isDefault).map((a) => a.id);
  const candidate = rotation.find((id) => !activeIds.has(id) && accounts.some((a) => a.id === id));

  const base = {
    ok: true,
    enabled: settings.autoSwitch.enabled,
    mode: settings.autoSwitch.mode,
    spent: isNew,
    event: newest ?? null,
    activeAccounts: [...activeIds],
    candidate: candidate ?? null,
    acted: false as boolean,
    switched: [] as string[],
  };

  const shouldAct =
    isNew && settings.autoSwitch.enabled && settings.autoSwitch.mode === 'switch' && !!candidate;

  if (shouldAct) {
    const to = findAccount(accounts, candidate!);
    for (const host of hosts) switchHost(provider, host, to, accounts);
    base.acted = true;
    base.switched = hosts.map((h) => h.id);
  }

  if (isNew && (shouldAct || settings.autoSwitch.enabled)) {
    saveState({
      ...state,
      lastHandledLimitAt: newest!.at,
      ...(shouldAct ? { lastSwitchedTo: candidate!, lastSwitchedAt: new Date().toISOString() } : {}),
    });
  }

  if (asJson) return emit(base);

  if (!isNew) {
    console.log(green('✓ no new limit events.'));
    return;
  }
  console.log(yellow(`Limit reached — ${newest!.message}`));
  if (!settings.autoSwitch.enabled) {
    console.log(dim('Auto-switch is off. Turn it on: baton settings set autoSwitch.enabled true'));
  } else if (!candidate) {
    console.log(yellow('No spare account to switch to. Add one with `baton add <name>`.'));
  } else if (base.acted) {
    console.log(green(`✓ switched ${base.switched.join(', ')} → ${candidate}`));
    console.log(dim('Reload the editor window, then `claude --resume`.'));
  } else {
    console.log(`Suggested: ${bold(candidate)}  ${dim('(mode is notify, so nothing was changed)')}`);
  }
}

// ---------------------------------------------------------------- doctor

function cmdDoctor(): void {
  const issues: { level: 'warn'; message: string; fix?: string }[] = [];
  for (const provider of PROVIDERS) {
    const accounts = provider.discoverAccounts();
    for (const h of provider.discoverHosts()) {
      if (h.inconsistent) {
        issues.push({
          level: 'warn',
          message: `${h.label}: the two ${provider.envVar} settings disagree.`,
          fix: `baton use <account> --host ${h.id}`,
        });
      }
      if (h.configDir && !accounts.some((a) => a.configDir === h.configDir)) {
        issues.push({ level: 'warn', message: `${h.label} points at an unrecognised dir: ${h.configDir}` });
      }
    }
    for (const a of accounts.filter((x) => !x.email)) {
      issues.push({ level: 'warn', message: `${a.id}: no account identity found — may need \`claude /login\`.` });
    }
  }
  // ok reports whether the check ran; healthy reports what it found. Collapsing
  // the two made a successful check that found problems look like a failure.
  if (asJson) return emit({ ok: true, healthy: issues.length === 0, issues });
  for (const i of issues) {
    console.log(yellow(`⚠ ${i.message}`));
    if (i.fix) console.log(dim(`  Fix: ${i.fix}`));
  }
  console.log(issues.length ? `\n${issues.length} issue(s).` : green('✓ everything consistent.'));
}

// ---------------------------------------------------------------- main

const HELP = `${bold('baton')} — switch AI coding accounts across editors, keeping one shared history.

  baton setup                     guided first-time walkthrough
  baton status                    show accounts, editors, and what points where
  baton add <name>                create a new account directory to log into
  baton use <account> [opts]      point an editor at an account
  baton link [account|--all]      share history across accounts (run once)
  baton unlink <account>          restore an account to standalone files
  baton alias <account> [name]    set a display name (screenshots); empty clears
  baton settings [set <k> <v>]    view or change preferences
  baton history [--offset n]      browse pooled conversations (50 per page)
  baton autoswitch                check for a spent account and act on it
  baton doctor                    find half-applied or inconsistent bindings

Options
  --host <id>      only this editor (default: every editor already bound)
  --all            every editor (use) / every account (link)
  --provider <id>  ${PROVIDERS.map((p) => p.id).join(', ')}
  --dry-run        print what would change, write nothing
  --json           machine-readable output (used by the GUI)
`;

async function main(): Promise<void> {
  switch (positional[0]) {
    case 'status': case undefined: cmdStatus(); break;
    case 'setup': await runSetup(resolveProvider()); break;
    case 'add': cmdAdd(); break;
    case 'use': cmdUse(); break;
    case 'link': cmdLink(); break;
    case 'unlink': cmdUnlink(); break;
    case 'settings': case 'config': cmdSettings(); break;
    case 'history': cmdHistory(); break;
    case 'autoswitch': cmdAutoswitch(); break;
    case 'alias': cmdAlias(); break;
    case 'doctor': cmdDoctor(); break;
    case 'help': console.log(HELP); break;
    default:
      if (asJson) emit({ ok: false, error: `Unknown command "${positional[0]}"` });
      else { console.error(`Unknown command "${positional[0]}"\n`); console.log(HELP); }
      process.exit(1);
  }
}

main().catch((err: Error) => {
  if (asJson) emit({ ok: false, error: err.message });
  else console.error(`\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});
