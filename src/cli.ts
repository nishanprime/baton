#!/usr/bin/env node
import fs, { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PROVIDERS, getProvider, defaultProvider } from './core/registry.ts';
import { linkAccount, unlinkAccount } from './core/share.ts';
import { switchHost } from './core/switch.ts';
import { appHome, sharedStore } from './core/paths.ts';
import { runSetup, createAccount, loginHint } from './core/setup.ts';
import { loadSettings, saveSettings, setSetting, setAlias, settingsPath, SCHEMA } from './core/settings.ts';
import { accountLabel, accountEmail, makeProjectMasker, maskPath, maskPathsInText } from './core/display.ts';
import { listConversations } from './core/history.ts';
import {
  listSnapshots, pruneSnapshots, restoreSnapshot, backupStats, policyFromSettings,
  withSnapshot, pruneSnapshots as applyRetention,
} from './core/backups.ts';
import {
  shellCommand, execCommand, envScript, initScript, detectShell, rcFile,
  currentAccountFromEnv, PARENT_SHELL_NOTE, type InitShell,
} from './core/terminal.ts';
import { preflight, renderPreflight, formatBytes } from './core/preflight.ts';
import {
  classifyAccounts, reauthCommand, removeAccount, canRemoveAccount, renameAccount,
} from './core/lifecycle.ts';
import { accountHealth, UNAVAILABLE_FIELDS } from './core/health.ts';
import { findLiveSessions } from './core/sessions.ts';
import { buildUsageReport } from './core/usage.ts';
import { recordObservation, attributionStats, setStatedAttribution } from './core/attribution.ts';
import { listPins, setPin, removePin, pinFor } from './core/pins.ts';
import { notify } from './core/notify.ts';
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
    const sessions = findLiveSessions([provider], accounts);
    // Polling here as well as in `sessions` is what makes attribution fill in
    // during ordinary use rather than only when someone goes looking.
    recordObservation(provider, sessions);
    return { provider, accounts, hosts, sessions, here: currentAccountFromEnv(provider) };
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
        sessions: data.find((d) => d.provider.id === provider.id)?.sessions ?? [],
        terminal: data.find((d) => d.provider.id === provider.id)?.here ?? null,
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
    const d = data.find((x) => x.provider.id === provider.id);
    console.log(`\n ${bold('This terminal')}`);
    console.log(
      d?.here
        ? `  ${green(d.here)} ${dim(`via ${provider.envVar}`)}`
        : dim(`  no account set — ${provider.label} would use the default`),
    );

    if (d?.sessions.length) {
      console.log(`\n ${bold('Running now')}`);
      for (const sn of d.sessions) {
        console.log(`  pid ${String(sn.pid).padEnd(8)} ${green(sn.accountId ?? 'unknown')} ${dim(sn.editorHint ?? '')}`);
      }
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

  const plan = () => targets.map((host) => switchHost(provider, host, to, accounts, { dryRun }));
  const results = dryRun ? plan() : withSnapshot(`switch:${to.id}`, plan).result;
  if (!dryRun) applyRetention(policyFromSettings());

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
  const plan = () =>
    targets.map((a) => ({
      account: a.id,
      configDir: a.configDir,
      actions: linkAccount(provider, a, { dryRun, storeState }).filter((x) => x.action !== 'skipped'),
    }));

  const report = dryRun ? plan() : withSnapshot('link', plan).result;
  if (!dryRun) applyRetention(policyFromSettings());

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

  recordObservation(provider, findLiveSessions([provider], accounts));

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

  // Reaches the user in the editor they are actually looking at.
  if (isNew && settings.autoSwitch.enabled) {
    if (base.acted) {
      notify('Baton switched accounts', `${[...activeIds].join(', ')} hit its limit — now on ${candidate}.`);
    } else if (candidate) {
      notify('Account limit reached', `${[...activeIds].join(', ')} is spent. Switch to ${candidate}.`);
    } else {
      notify('Account limit reached', `${[...activeIds].join(', ')} is spent and there is no spare account.`);
    }
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

// ---------------------------------------------------------------- accounts

const STATE_LABEL: Record<string, string> = {
  draft: 'draft — never logged in',
  active: 'active',
  idle: 'ready',
  spent: 'limit reached',
};

function cmdAccounts(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();

  // Shell completions call this; one bare id per line, nothing else on stdout.
  if (flags.has('--ids')) {
    for (const a of accounts) console.log(a.id);
    return;
  }

  const settings = loadSettings();
  const statuses = classifyAccounts(provider, accounts);

  if (asJson) {
    return emit({
      ok: true,
      // Reported once for the list: it is a fact about the history, not about
      // any single account.
      unattributedLimits: statuses.reduce((n, st) => Math.max(n, st.unattributedLimits), 0),
      accounts: statuses.map((st) => {
        const a = accounts.find((x) => x.id === st.accountId)!;
        return {
          ...st,
          displayName: accountLabel(st.accountId, settings),
          displayEmail: accountEmail(st.email, settings),
          // Masked for screen sharing, same as status emits.
          displayDir: maskPath(st.configDir, settings),
          hasAlias: st.accountId in settings.display.aliases,
          isDefault: a.isDefault,
          reauth: reauthCommand(provider, a),
          removable: canRemoveAccount(provider, a),
        };
      }),
    });
  }

  const unplaced = statuses.reduce((n, st) => Math.max(n, st.unattributedLimits), 0);

  console.log(`${bold('Accounts')}\n`);
  for (const st of statuses) {
    const tag = st.state === 'draft' ? yellow(STATE_LABEL[st.state]!) : dim(STATE_LABEL[st.state]!);
    console.log(`  ${bold(accountLabel(st.accountId, settings).padEnd(16))} ${tag}`);
    console.log(`    ${dim(st.reason)}`);
    if (st.loginCommand) console.log(`    ${bold(st.loginCommand)}`);
    else console.log(`    ${dim(st.nextAction)}`);
  }

  if (unplaced) {
    console.log(
      `\n${yellow('!')} ${unplaced} recent limit event${unplaced === 1 ? '' : 's'} could not be traced to an account.`,
    );
    console.log(dim('  It happened before Baton was watching, and the history does not record whose it was.'));
    console.log(dim('  If you know: baton limit <account>'));
  }
}

function cmdReauth(): void {
  const provider = resolveProvider();
  const key = positional[1];
  if (!key) throw new Error('Usage: baton reauth <account>');
  const account = findAccount(provider.discoverAccounts(), key);
  const cmd = reauthCommand(provider, account);
  if (asJson) return emit({ ok: true, account: account.id, ...cmd });
  console.log(`${bold(cmd.command)}\n`);
  console.log(dim(cmd.explanation));
}

function cmdRemove(): void {
  const provider = resolveProvider();
  const key = positional[1];
  if (!key) throw new Error('Usage: baton remove <account> [--delete-history] [--force] [--dry-run]');
  const accounts = provider.discoverAccounts();
  const account = findAccount(accounts, key);
  const history = flags.has('--delete-history') ? 'delete' as const : 'keep' as const;
  const opts = { dryRun, force: flags.has('--force'), history };

  const check = canRemoveAccount(provider, account, opts);
  if (!check.ok && !opts.force) {
    if (asJson) return emit({ ok: false, error: check.refusals.map((r) => r.message).join(' '), refusals: check.refusals });
    for (const r of check.refusals) {
      console.log(yellow(`✗ ${r.message}`));
      if (r.overridable) console.log(dim('  Pass --force to override.'));
    }
    process.exit(1);
  }

  const result = removeAccount(provider, account, opts);
  if (asJson) return emit({ ok: true, ...result });

  console.log(`${dryRun ? yellow('[dry-run]') : green('✓')} ${dryRun ? 'would remove' : 'removed'} ${bold(account.id)}`);
  console.log(dim(`  ${result.removed.length} path(s) removed, ${result.preserved.length} preserved`));
  if (history === 'keep') console.log(dim('  Conversation history was left in the shared store, untouched.'));
  if (result.backupPath) console.log(dim(`  snapshot: ${result.backupPath}`));
  for (const h of result.rebind) {
    console.log(yellow(`  ⚠ ${h.label} still points here — run: baton use <other> --host ${h.id}`));
  }
  for (const w of result.warnings) console.log(yellow(`  ⚠ ${w}`));
}

function cmdRename(): void {
  const provider = resolveProvider();
  const [key, newId] = positional.slice(1);
  if (!key || !newId) throw new Error('Usage: baton rename <account> <new-name> [--confirm]');
  const account = findAccount(provider.discoverAccounts(), key);
  // Without --confirm this is a preflight: renameAccount reports and moves nothing.
  const plan = renameAccount(provider, account, newId, {
    confirm: flags.has('--confirm') && !dryRun,
    force: flags.has('--force'),
  });

  if (asJson) return emit({ ok: true, ...plan });

  console.log(`${bold(account.id)} → ${bold(newId)}  ${dim(plan.toDir)}`);
  for (const b of plan.blockers) console.log(`  ${yellow('✗')} ${b.message}`);
  for (const c of plan.consequences) console.log(`  ${yellow('•')} ${c.detail}`);
  for (const k of plan.settingsReferences) {
    console.log(`  ${yellow('•')} settings key ${k} still names the old id`);
  }
  if (!plan.moved) {
    console.log(dim('\nNothing changed. Re-run with --confirm to apply.'));
    console.log(dim('For a display-only change that touches no paths, use `baton alias`.'));
  } else {
    console.log(green('\n✓ renamed.'));
    for (const h of plan.rebind) {
      console.log(yellow(`  ⚠ re-point ${h.label}: baton use ${newId} --host ${h.id}`));
    }
  }
}

/**
 * Settle a limit event Baton could not place.
 *
 * Attribution only covers what Baton watched; the person at the keyboard knows
 * which account was in the editor before that. This is how they say so.
 */
function cmdLimit(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const key = positional[1];
  if (!key) throw new Error('Usage: baton limit <account> [--not]   (say whose a recent limit was)');
  const account = findAccount(accounts, key);

  const windowMinutes = Number(flagValue('--since') ?? 300);
  const events = findLimitEvents([provider], { sinceMinutes: windowMinutes });
  if (!events.length) {
    if (asJson) return emit({ ok: true, updated: 0, note: 'no recent limit events' });
    console.log(dim('No limit events in the last ' + windowMinutes + ' minutes.'));
    return;
  }

  const ruleOut = flags.has('--not');
  for (const e of events) {
    setStatedAttribution(e.sessionId, ruleOut ? null : account.id, { ruleOut: account.id });
  }

  if (asJson) {
    return emit({ ok: true, account: account.id, ruledOut: ruleOut, updated: events.length });
  }
  console.log(
    ruleOut
      ? `${green('✓')} ${bold(account.id)} ruled out for ${events.length} recent limit event(s).`
      : `${green('✓')} ${events.length} recent limit event(s) recorded as ${bold(account.id)}'s.`,
  );
  console.log(dim('Stated by you, so it outranks anything Baton inferred.'));
}

// ---------------------------------------------------------------- health

function cmdHealth(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const health = accountHealth(provider, accounts);
  if (asJson) return emit({ ok: true, accounts: health, unavailable: UNAVAILABLE_FIELDS });

  console.log(`${bold('Health')}\n`);
  for (const h of health) {
    const mark = h.status === 'ok' ? green('●') : h.status === 'spent' ? yellow('●') : dim('○');
    console.log(`  ${mark} ${bold(h.label.padEnd(16))} ${dim(h.reason)}`);
    if (h.spent.known && h.spent.value.resets) {
      console.log(`    ${yellow(`resets ${h.spent.value.resets}`)}`);
    }
    if (h.liveSessions.known && h.liveSessions.value.count) {
      console.log(dim(`    ${h.liveSessions.value.count} live session(s)`));
    }
  }
  console.log(`\n${dim('Not knowable locally:')}`);
  for (const f of UNAVAILABLE_FIELDS) console.log(dim(`  ${f.label} — ${f.why}`));
}

function cmdSessions(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const sessions = findLiveSessions([provider], accounts);
  recordObservation(provider, sessions);
  if (asJson) return emit({ ok: true, sessions, attribution: attributionStats([provider]) });
  console.log(`${bold('Live sessions')} ${dim(`${sessions.length}`)}\n`);
  for (const s of sessions) {
    console.log(`  pid ${String(s.pid).padEnd(8)} ${bold(s.accountId ?? 'unknown')}  ${dim(`${s.editorHint ?? '?'} · ${s.entrypoint ?? '?'}`)}`);
  }
  if (!sessions.length) console.log(dim('  none'));
}

function cmdUsage(): void {
  const provider = resolveProvider();
  const filter = {
    project: flagValue('--project'),
    since: flagValue('--since'),
    until: flagValue('--until'),
  };
  const report = buildUsageReport([provider], filter);
  if (asJson) return emit({ ok: true, filter, ...report });

  const scope = [
    filter.project && `project ${filter.project}`,
    filter.since && `since ${filter.since}`,
    filter.until && `until ${filter.until}`,
  ].filter(Boolean).join(', ');
  console.log(
    `${bold('Usage')} ${dim(`${report.conversations} conversations${scope ? ` · ${scope}` : ''}`)}\n`,
  );
  for (const m of report.models) {
    const cost = m.costUsd === null ? dim('unpriced') : `$${m.costUsd.toFixed(2)}`;
    console.log(`  ${m.model.padEnd(26)} ${String(m.turns).padStart(7)} turns  ${cost}`);
  }
  console.log(`\n  ${bold('API-equivalent'.padEnd(26))} ${String(report.totals.turns).padStart(7)} turns  ${bold(`$${report.totals.costUsd.toFixed(2)}`)}`);
  console.log(dim('\nWhat this work would have cost at published API rates.'));
  if (report.syntheticMessages) {
    console.log(
      dim(
        `${report.syntheticMessages} local message(s) excluded — errors and notices Claude Code ` +
          'wrote itself, with no API call behind them.',
      ),
    );
  }
  console.log(dim('No per-account breakdown: transcripts never recorded the account, and pooling merged them.'));
}

// ---------------------------------------------------------------- backups

function cmdBackups(): void {
  const sub = positional[1];
  const policy = policyFromSettings();

  if (sub === 'prune') {
    const result = pruneSnapshots(
      {
        keepCount: flagValue('--keep') ? Number(flagValue('--keep')) : policy.keepCount,
        maxTotalMb: flagValue('--max-size') ? Number(flagValue('--max-size')) : policy.maxTotalMb,
        maxAgeDays: flagValue('--max-age') ? Number(flagValue('--max-age')) : policy.maxAgeDays,
        maxCount: flagValue('--max-count') ? Number(flagValue('--max-count')) : policy.maxCount,
      },
      { dryRun },
    );
    if (asJson) return emit({ ok: true, ...result });
    const verb = dryRun ? 'would delete' : 'deleted';
    console.log(`${green('✓')} ${verb} ${result.deleted.length} snapshot(s), freeing ${formatBytes(result.bytesFreed)}`);
    for (const d of result.deleted) console.log(`  ${dim(d.id)}  ${dim(`(${d.reason})`)}`);
    console.log(dim(`${formatBytes(result.bytesRemaining)} remaining`));
    return;
  }

  if (sub === 'restore') {
    const id = positional[2];
    if (!id) throw new Error('Usage: baton backups restore <id> [--dry-run]');
    const result = restoreSnapshot(id, { dryRun });
    if (asJson) return emit({ ok: true, ...result });
    console.log(`${dryRun ? yellow('[dry-run]') : green('✓')} restored ${result.restored} entr(ies) from ${bold(id)}`);
    for (const e of result.entries) {
      const mark = e.action === 'restored' ? green('✓') : yellow('·');
      console.log(`  ${mark} ${e.tag.padEnd(24)} ${dim(e.reason ?? e.originalPath)}`);
    }
    if (!dryRun) console.log(dim('A pre-restore snapshot was taken first, so this is undoable.'));
    return;
  }

  const snapshots = listSnapshots();
  const stats = backupStats();
  if (asJson) return emit({ ok: true, policy, stats, snapshots });

  console.log(`${bold('Backups')} ${dim(`${stats.count} snapshots · ${formatBytes(stats.totalBytes)}`)}\n`);
  for (const s of snapshots) {
    const when = s.createdAt ? s.createdAt.slice(0, 16).replace('T', ' ') : dim('unknown');
    const flag = s.degraded ? yellow(' (no manifest)') : '';
    console.log(`  ${bold(s.id)}`);
    console.log(`    ${dim(`${s.label} · ${when} · ${formatBytes(s.bytes)} · ${s.entries.length} entries`)}${flag}`);
  }
  if (!snapshots.length) console.log(dim('  none yet'));
  console.log(
    `\n${dim(
      `Keeping the newest ${policy.keepCount}, at most ${policy.maxCount ?? '∞'} total, ` +
        `up to ${policy.maxTotalMb}MB, for ${policy.maxAgeDays} days. Older ones go automatically.`,
    )}`,
  );
  if (stats.overBudget) {
    console.log(yellow(`Over budget — ${stats.wouldPrune} snapshot(s) would be pruned. Run: baton backups prune`));
  }
  console.log(dim('Restore with: baton backups restore <id>'));
}

// ---------------------------------------------------------------- terminal

function cmdShell(): void {
  const provider = resolveProvider();
  const pinned = pinFor(process.cwd());
  const key = positional[1] ?? pinned?.accountId;
  if (!key) {
    throw new Error(
      'Usage: baton shell <account>\n' +
        'Or pin this directory once with `baton pin <account>` and omit the argument.',
    );
  }
  const account = findAccount(provider.discoverAccounts(), key);
  if (!positional[1] && pinned) {
    console.error(dim(`using ${account.id}, pinned at ${pinned.dir}`));
  }
  const plan = shellCommand(provider, account);
  if (asJson) return emit({ ok: true, account: account.id, ...plan });
  console.log(dim(`starting a shell on ${account.id} — exit to return`));
  spawnPlan(plan);
}

function cmdExec(): void {
  const provider = resolveProvider();
  const sep = argv.indexOf('--');
  const key = positional[1];
  if (!key || sep < 0) throw new Error('Usage: baton exec <account> -- <command...>');
  const account = findAccount(provider.discoverAccounts(), key);
  const plan = execCommand(provider, account, argv.slice(sep + 1));
  if (asJson) return emit({ ok: true, account: account.id, ...plan });
  spawnPlan(plan);
}

/** Run the planned command inline so its exit code becomes ours. */
function spawnPlan(plan: { argv: string[]; env: Record<string, string> }): void {
  const [bin, ...rest] = plan.argv;
  if (!bin) throw new Error('nothing to run');
  const r = spawnSync(bin, rest, { stdio: 'inherit', env: { ...process.env, ...plan.env } });
  if (r.error) throw r.error;
  process.exit(r.status ?? 0);
}

function cmdEnv(): void {
  const provider = resolveProvider();
  const key = positional[1];
  if (!key) throw new Error('Usage: eval "$(baton env <account>)"');
  const account = findAccount(provider.discoverAccounts(), key);
  const shell = (flagValue('--shell') as InitShell | undefined) ?? detectShell();
  const script = envScript(provider, account, shell === 'unknown' ? 'bash' : shell);
  if (asJson) return emit({ ok: true, account: account.id, script });
  console.log(script);
}

function cmdInit(): void {
  const requested = (positional[1] as InitShell | undefined) ?? detectShell();
  if (!requested || requested === 'unknown') {
    throw new Error('Usage: baton init <zsh|bash|fish>');
  }
  const script = initScript(requested);
  if (asJson) return emit({ ok: true, shell: requested, script, rcFile: rcFile(requested) });
  console.log(script);
  console.error(dim(`\n# Add to ${rcFile(requested)}:  baton init ${requested} >> ${rcFile(requested)}`));
  console.error(dim(`# ${PARENT_SHELL_NOTE}`));
}

// ---------------------------------------------------------------- preflight

function cmdPreflight(): void {
  const report = preflight();
  if (asJson) return emit({ ok: true, report });
  // renderPreflight returns lines so callers choose where they go.
  console.log(renderPreflight(report).join('\n'));
}

// ---------------------------------------------------------------- pins

function cmdPin(): void {
  const provider = resolveProvider();
  const key = positional[1];
  const dir = positional[2] ?? process.cwd();

  if (!key) {
    const pins = listPins();
    if (asJson) return emit({ ok: true, pins, here: pinFor(process.cwd()) });
    console.log(`${bold('Pinned directories')}\n`);
    for (const p of pins) console.log(`  ${bold(p.accountId.padEnd(16))} ${dim(p.dir)}`);
    if (!pins.length) console.log(dim('  none'));
    const here = pinFor(process.cwd());
    console.log(`\n${dim(here ? `Here resolves to ${here.accountId} (via ${here.dir})` : 'This directory is not pinned.')}`);
    return;
  }

  const account = findAccount(provider.discoverAccounts(), key);
  const pin = setPin(dir, account.id);
  if (asJson) return emit({ ok: true, ...pin });
  console.log(`${green('✓')} ${bold(pin.dir)} → ${bold(account.id)}`);
  console.log(dim('Covers this directory and everything under it. `baton shell` here needs no argument.'));
}

function cmdUnpin(): void {
  const dir = positional[1] ?? process.cwd();
  const removed = removePin(dir);
  if (asJson) return emit({ ok: true, removed, dir });
  console.log(removed ? `${green('✓')} unpinned ${dir}` : yellow(`${dir} was not pinned`));
}

// ---------------------------------------------------------------- config transfer

const CONFIG_VERSION = 1;

/**
 * Baton's own preferences, for moving to another machine.
 *
 * Deliberately not included: credentials (Baton never touches them),
 * conversation history (gigabytes, and pooling is per-machine), and absolute
 * config-dir paths, which differ per machine and per user. What transfers is
 * the part that took thought — retention policy, auto-switch behaviour,
 * aliases — keyed by account id so it lands wherever those accounts live.
 */
function cmdExport(): void {
  const settings = loadSettings();
  const payload = {
    version: CONFIG_VERSION,
    exportedFrom: process.platform,
    settings,
    // Pins are absolute paths and rarely survive a move; carried so the user
    // can see and re-point them rather than losing them silently.
    pins: listPins(),
  };
  if (asJson) return emit({ ok: true, ...payload });
  console.log(JSON.stringify(payload, null, 2));
}

function cmdImport(): void {
  const file = positional[1];
  if (!file) throw new Error('Usage: baton import <file.json> [--dry-run]');

  let payload: { version?: number; settings?: unknown; pins?: { dir: string; accountId: string }[] };
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof payload;
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  if (payload.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported export version ${payload.version ?? '(missing)'}; expected ${CONFIG_VERSION}.`);
  }

  const incoming = payload.settings as Partial<ReturnType<typeof loadSettings>> | undefined;
  if (!incoming) throw new Error('That file carries no settings.');

  const current = loadSettings();
  const merged = { ...current, ...incoming, display: { ...current.display, ...incoming.display } };
  const known = provided(payload.pins ?? []);

  if (!dryRun) {
    saveSettings(merged);
    for (const pin of known.valid) setPin(pin.dir, pin.accountId);
  }

  if (asJson) {
    return emit({ ok: true, dryRun, applied: Object.keys(incoming), pins: known });
  }
  console.log(`${dryRun ? yellow('[dry-run]') : green('✓')} ${dryRun ? 'would import' : 'imported'} settings from ${file}`);
  console.log(dim(`  ${known.valid.length} pin(s) applied, ${known.missing.length} skipped`));
  for (const p of known.missing) {
    console.log(yellow(`  ⚠ pin for ${p.dir} skipped — that directory does not exist here`));
  }
}

/** Split incoming pins by whether their directory exists on this machine. */
function provided(pins: { dir: string; accountId: string }[]) {
  const valid = pins.filter((p) => existsSync(p.dir));
  return { valid, missing: pins.filter((p) => !existsSync(p.dir)) };
}

// ---------------------------------------------------------------- uninstall

/**
 * Undo Baton, leaving every account standalone again.
 *
 * The shared store is the only copy of pooled history, so this materialises it
 * back into each account before removing anything. Anyone who adopts a tool
 * that rearranges their files deserves a way out that does not require trusting
 * the tool a second time.
 */
function cmdUninstall(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const hosts = provider.discoverHosts().filter((h) => h.configDir);

  const plan = accounts.map((a) => ({
    account: a.id,
    entries: unlinkAccount(provider, a, { dryRun: true }).map((x) => x.entry),
  }));

  if (asJson && dryRun) {
    return emit({ ok: true, dryRun: true, plan, hosts: hosts.map((h) => h.id), appHome: appHome() });
  }

  if (!dryRun && !flags.has('--yes')) {
    throw new Error(
      'This restores every account to standalone files and leaves editor settings pointing where they are.\n' +
        'Re-run with --yes once you have read `baton uninstall --dry-run`.',
    );
  }

  const done = accounts.map((a) => ({
    account: a.id,
    entries: unlinkAccount(provider, a, { dryRun }).map((x) => x.entry),
  }));

  if (asJson) return emit({ ok: true, dryRun, accounts: done, appHome: appHome() });

  for (const r of done) {
    console.log(`${dryRun ? yellow('[dry-run]') : green('✓')} ${bold(r.account)} ${dim(`${r.entries.length} entries materialised`)}`);
  }
  if (dryRun) {
    console.log(dim('\nNothing was changed. Re-run with --yes to apply.'));
    return;
  }
  console.log(`\n${green('Done.')} Every account holds its own files again.`);
  console.log(dim(`Baton's own state is still at ${appHome()} — delete it when you are sure:`));
  console.log(dim(`  rm -rf ${appHome()}`));
  console.log(dim('Editors still point at their accounts; that is just an env var and is harmless.'));
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
    // A generic "run /login" is useless when several accounts need it: the
    // command differs per account because it names that account's directory.
    for (const a of accounts.filter((x) => !x.email)) {
      const { command } = reauthCommand(provider, a);
      issues.push({
        level: 'warn',
        message: `${a.id} has never been logged in.`,
        fix: command,
      });
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
  baton accounts                  accounts with their state and next action
  baton add <name>                create a new account directory to log into
  baton reauth <account>          the exact command to log that account in
  baton remove <account>          delete an account (history is kept by default)
  baton rename <account> <new>    move its directory and re-point editors
  baton health                    per-account status and limits
  baton limit <account> [--not]   say whose a recent limit was, when Baton
                                  cannot tell
  baton sessions                  sessions running right now
  baton usage [--project x]       tokens and API-equivalent cost
                                  also --since / --until (ISO dates)
  baton use <account> [opts]      point an editor at an account
  baton link [account|--all]      share history across accounts (run once)
  baton unlink <account>          restore an account to standalone files
  baton uninstall                 undo Baton entirely (try --dry-run first)
  baton export > baton.json       your settings, aliases and pins
  baton import <file>             apply them on another machine
  baton alias <account> [name]    set a display name (screenshots); empty clears
  baton settings [set <k> <v>]    view or change preferences
  baton history [--offset n]      browse pooled conversations (50 per page)
  baton autoswitch                check for a spent account and act on it
  baton doctor                    find half-applied or inconsistent bindings
  baton preflight                 what is installed, found, and running

Terminal
  baton shell <account>           start a shell bound to an account
  baton exec <account> -- <cmd>   run one command under an account
  baton env <account>             printable exports: eval "$(baton env work)"
  baton init <zsh|bash|fish>      shell integration for the current shell
  baton pin [account] [dir]       pin a directory tree to an account; bare to list
  baton unpin [dir]               remove a pin

Backups
  baton backups                   list snapshots and the retention policy
  baton backups prune             apply retention now
  baton backups restore <id>      restore a snapshot (itself undoable)

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
    case 'backups': cmdBackups(); break;
    case 'shell': cmdShell(); break;
    case 'exec': cmdExec(); break;
    case 'env': cmdEnv(); break;
    case 'init': cmdInit(); break;
    case 'preflight': cmdPreflight(); break;
    case 'accounts': cmdAccounts(); break;
    case 'reauth': cmdReauth(); break;
    case 'remove': cmdRemove(); break;
    case 'rename': cmdRename(); break;
    case 'limit': cmdLimit(); break;
    case 'health': cmdHealth(); break;
    case 'sessions': cmdSessions(); break;
    case 'usage': cmdUsage(); break;
    case 'uninstall': cmdUninstall(); break;
    case 'export': cmdExport(); break;
    case 'import': cmdImport(); break;
    case 'pin': cmdPin(); break;
    case 'unpin': cmdUnpin(); break;
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
