#!/usr/bin/env node
import { PROVIDERS, getProvider, defaultProvider } from './core/registry.ts';
import { linkAccount, unlinkAccount } from './core/share.ts';
import { switchHost } from './core/switch.ts';
import { appHome, sharedStore } from './core/paths.ts';
import type { Account, Host, Provider } from './core/types.ts';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');

const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function resolveProvider(): Provider {
  const id = flagValue('--provider');
  return id ? getProvider(id) : defaultProvider();
}

function findAccount(accounts: Account[], key: string): Account {
  const hit = accounts.find((a) => a.id === key || a.configDir === key || a.email === key);
  if (!hit) {
    throw new Error(
      `No account "${key}". Known: ${accounts.map((a) => a.id).join(', ') || '(none found)'}`,
    );
  }
  return hit;
}

function describeAccount(a: Account, hosts: Host[]): string {
  const users = hosts.filter((h) => h.configDir === a.configDir).map((h) => h.label);
  const who = a.email ? dim(` ${a.email}`) : dim(' (not logged in?)');
  const used = users.length ? green(`  ← ${users.join(', ')}`) : '';
  return `  ${bold(a.id.padEnd(16))}${who}${used}\n    ${dim(a.configDir)}`;
}

function cmdStatus(): void {
  console.log(`${bold('Baton')} ${dim(`· state in ${appHome()}`)}\n`);
  for (const provider of PROVIDERS) {
    const accounts = provider.discoverAccounts();
    const hosts = provider.discoverHosts();
    console.log(`${bold(provider.label)} ${dim(`(${provider.envVar})`)}`);

    console.log(`\n ${bold('Accounts')}`);
    if (!accounts.length) console.log(dim('  none found'));
    for (const a of accounts) console.log(describeAccount(a, hosts));

    console.log(`\n ${bold('Editors')}`);
    if (!hosts.length) console.log(dim('  none found'));
    for (const h of hosts) {
      const acct = accounts.find((a) => a.configDir === h.configDir);
      const label = acct ? green(acct.id) : h.configDir ? yellow('unmanaged dir') : dim('default');
      const warn = h.inconsistent ? yellow('  ⚠ settings keys disagree — run `baton doctor`') : '';
      console.log(`  ${h.label.padEnd(18)} ${label}${warn}`);
      console.log(`    ${dim(h.configFile)}`);
    }
    console.log(`\n ${bold('Shared store')}  ${dim(sharedStore(provider.id))}\n`);
  }
}

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

  if (!targets.length) throw new Error(`No matching editor. Known: ${hosts.map((h) => h.id).join(', ')}`);

  for (const host of targets) {
    const r = switchHost(provider, host, to, accounts, { dryRun });
    const prefix = dryRun ? yellow('[dry-run]') : green('✓');
    console.log(`${prefix} ${host.label} → ${bold(to.id)}${to.email ? dim(` (${to.email})`) : ''}`);
    if (r.from) console.log(dim(`    carried project state forward from ${r.from.id}`));
    console.log(dim(`    ${host.configFile}`));
  }
  if (!dryRun) {
    console.log(`\n${yellow('Reload the editor window')} for the change to take effect.`);
    console.log(dim('Then `claude --resume` — your conversations are all still there.'));
  }
}

function cmdLink(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const key = positional[1];
  const targets = flags.has('--all') || !key ? accounts : [findAccount(accounts, key)];

  // Shared across accounts so a dry run predicts merges the way a real run does.
  const storeState = new Set<string>();
  for (const a of targets) {
    console.log(`${bold(a.id)} ${dim(a.configDir)}`);
    for (const act of linkAccount(provider, a, { dryRun, storeState })) {
      if (act.action === 'skipped') continue;
      const mark = act.action === 'overwritten-by-store' ? yellow('!') : dryRun ? yellow('·') : green('✓');
      console.log(`  ${mark} ${act.entry.padEnd(18)} ${dim(act.action)}${act.detail ? dim(` — ${act.detail}`) : ''}`);
    }
  }
  console.log(`\n${dim(`shared store: ${sharedStore(provider.id)}`)}`);
}

function cmdUnlink(): void {
  const provider = resolveProvider();
  const accounts = provider.discoverAccounts();
  const key = positional[1];
  if (!key) throw new Error('Usage: baton unlink <account> [--dry-run]');
  const a = findAccount(accounts, key);
  for (const act of unlinkAccount(provider, a, { dryRun })) {
    console.log(`  ${act.entry.padEnd(18)} ${dim(act.detail ?? '')}`);
  }
}

function cmdDoctor(): void {
  let problems = 0;
  for (const provider of PROVIDERS) {
    const accounts = provider.discoverAccounts();
    for (const h of provider.discoverHosts()) {
      if (h.inconsistent) {
        problems++;
        console.log(yellow(`⚠ ${h.label}: the two ${provider.envVar} settings disagree.`));
        console.log(dim(`  Fix: baton use <account> --host ${h.id}`));
      }
      if (h.configDir && !accounts.some((a) => a.configDir === h.configDir)) {
        problems++;
        console.log(yellow(`⚠ ${h.label} points at an unrecognised dir: ${h.configDir}`));
      }
    }
    for (const a of accounts) {
      if (!a.email) {
        problems++;
        console.log(yellow(`⚠ ${a.id}: no account identity found — may need \`claude /login\`.`));
      }
    }
  }
  console.log(problems ? `\n${problems} issue(s).` : green('✓ everything consistent.'));
}

const HELP = `${bold('baton')} — switch AI coding accounts across editors, keeping one shared history.

  baton status                    show accounts, editors, and what points where
  baton use <account> [opts]      point an editor at an account
  baton link [account|--all]      share history across accounts (run once)
  baton unlink <account>          restore an account to standalone files
  baton doctor                    find half-applied or inconsistent bindings

Options
  --host <id>      only this editor (default: every editor already bound)
  --all            every editor (use) / every account (link)
  --provider <id>  ${PROVIDERS.map((p) => p.id).join(', ')}
  --dry-run        print what would change, write nothing
`;

try {
  switch (positional[0]) {
    case 'status': case undefined: cmdStatus(); break;
    case 'use': cmdUse(); break;
    case 'link': cmdLink(); break;
    case 'unlink': cmdUnlink(); break;
    case 'doctor': cmdDoctor(); break;
    case 'help': console.log(HELP); break;
    default:
      console.error(`Unknown command "${positional[0]}"\n`);
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(`\x1b[31m${(err as Error).message}\x1b[0m`);
  process.exit(1);
}
