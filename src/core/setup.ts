import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { linkAccount } from './share.ts';
import { switchHost } from './switch.ts';
import { sharedStore, appHome, exists } from './paths.ts';
import { preflight, renderPreflight, type PreflightReport, type ProviderReport } from './preflight.ts';
import { PROVIDERS } from './registry.ts';
import { loginCommandForDir } from './lifecycle.ts';
import type { Account, Provider } from './types.ts';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const rule = () => console.log(dim('─'.repeat(64)));

function step(n: number, total: number, title: string): void {
  console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(title)}`);
  rule();
}

/** The questions a step can ask, so steps do not each own a readline. */
export interface SetupPrompt {
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  say(line?: string): void;
}

export interface TerminalStepContext extends SetupPrompt {
  provider: Provider;
  accounts: Account[];
  /** True when this machine has no editor at all, so the shell is the only way in. */
  isOnlyRoute: boolean;
}

export interface SetupOptions {
  /** Providers to walk. Defaults to every installed one the preflight finds. */
  providers?: Provider[];
  /** Walk this one first, when the caller has a reason to prefer it. */
  focus?: Provider;
  /**
   * The shell step, spliced in by the CLI. Setup never imports the terminal
   * module itself — it prints its own guidance when no step is supplied, so a
   * machine with no editors still finishes with something that works.
   */
  terminalStep?: (ctx: TerminalStepContext) => void | Promise<void>;
}

/** Directory a new named account would live in. */
export function accountDirFor(name: string, providerId = 'claude'): string {
  const clean = name.trim().replace(/^\.+/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  const prefix = `${providerId}-`;
  const stripped = clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
  return path.join(os.homedir(), `.${providerId}-${stripped || 'account'}`);
}

/**
 * Create an empty config dir for a new account. The provider's CLI does the
 * actual login; Baton only makes the directory it will log in to, so no
 * credential ever passes through here.
 */
export function createAccount(provider: Provider, name: string): string {
  const dir = accountDirFor(name, provider.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Delegates so there is one spelling of this command. The double-quoted form
 * this used to build left `$` and backticks live to the shell, so a config dir
 * containing either produced a command pointing somewhere other than the
 * account it names.
 */
export function loginHint(provider: Provider, dir: string): string {
  return loginCommandForDir(provider, dir);
}

/**
 * Whether an account directory is actually usable.
 *
 * A directory with no identity in it is a draft: editors can be pointed at it
 * and it will fail at the point of use, which is the worst time to find out.
 */
export function accountState(
  provider: Provider,
  dir: string,
): { state: 'missing' | 'unrecognised' | 'draft' | 'ready'; account?: Account } {
  if (!exists(dir)) return { state: 'missing' };
  const account = provider.discoverAccounts().find((a) => path.resolve(a.configDir) === path.resolve(dir));
  if (!account) return { state: 'unrecognised' };
  return { state: account.email ? 'ready' : 'draft', account };
}

/** Problems the walkthrough itself resolves, so they are not also listed up front. */
const HANDLED_CODES = new Set([
  'no-accounts',
  'single-account',
  'draft-account',
  'history-not-pooled',
  'no-editors',
]);

// ------------------------------------------------------------------ steps

async function addAccountStep(
  provider: Provider,
  accounts: Account[],
  p: SetupPrompt,
): Promise<Account[]> {
  if (accounts.length >= 2) {
    p.say(`You already have ${bold(String(accounts.length))} accounts. ${dim('Nothing to do here.')}`);
    const drafts = accounts.filter((a) => !a.email);
    for (const d of drafts) {
      p.say(`${yellow('!')} ${bold(d.id)} has never been logged into. Finish it with:`);
      p.say(`    ${cyan(loginHint(provider, d.configDir))}`);
    }
    return accounts;
  }

  p.say('Baton needs at least two accounts to switch between.');
  p.say(dim('Each account is its own config directory with its own login.\n'));

  let current = accounts;
  while (current.length < 2) {
    if (!(await p.confirm(current.length ? 'Add another account now?' : 'Create one now?'))) {
      p.say(dim(`Skipped. Add one later with ${cyan('baton add <name>')}, then re-run setup.`));
      return current;
    }

    const name = await p.ask(`Short name ${dim('(e.g. work, personal)')}: `, 'second');
    const dir = accountDirFor(name, provider.id);
    if (exists(dir)) p.say(dim(`${dir} already exists — reusing it rather than starting over.`));
    createAccount(provider, name);

    p.say(`\n${green('✓')} Created ${dir}`);
    p.say(`\nNow log into it in a ${bold('separate terminal')}:`);
    p.say(`  ${cyan(loginHint(provider, dir))}`);
    p.say(dim('  …then run /login inside it, and come back here.\n'));

    const verified = await verifyAccount(provider, dir, p, current);
    current = verified.accounts;
    if (!verified.ready) {
      p.say(dim('Finish the login when you can, then run setup again.'));
      return current;
    }
  }
  return current;
}

/**
 * Confirm the login actually happened.
 *
 * The old walkthrough took "press Enter" as proof and moved on, which is how a
 * machine ends up with config directories no editor can use.
 */
async function verifyAccount(
  provider: Provider,
  dir: string,
  p: SetupPrompt,
  previous: Account[],
): Promise<{ accounts: Account[]; ready: boolean }> {
  for (;;) {
    await p.ask(dim('Press Enter once you have logged in… '));
    const { state, account } = accountState(provider, dir);

    if (state === 'ready' && account) {
      p.say(`${green('✓')} ${bold(account.id)} is logged in as ${account.email}.`);
      return { accounts: provider.discoverAccounts(), ready: true };
    }

    p.say(
      state === 'missing'
        ? `${red('✗')} ${dir} is not there any more.`
        : state === 'unrecognised'
          ? `${red('✗')} Nothing in ${dir} yet — the CLI writes its files on first run, so it looks like it never started.`
          : `${yellow('!')} ${dir} exists, but there is no account identity in it. The login did not finish.`,
    );
    p.say(dim(`  Try again with: ${loginHint(provider, dir)}`));

    if (!(await p.confirm('Wait and check again?'))) {
      p.say(dim('Left as a draft. It will show as "not logged in" until you finish it.'));
      // Re-discover regardless: a draft directory the provider can already see
      // is one the rest of setup has to account for.
      const found = provider.discoverAccounts();
      return { accounts: found.length >= previous.length ? found : previous, ready: false };
    }
  }
}

async function poolHistoryStep(
  provider: Provider,
  accounts: Account[],
  report: ProviderReport,
  p: SetupPrompt,
): Promise<void> {
  if (accounts.length < 2) {
    p.say(dim('Only one account, so there is nothing to pool yet. Run `baton link --all` once you add a second.'));
    return;
  }
  if (report.history.state === 'pooled') {
    p.say(`${green('✓')} Already pooled — every account reads the same history.`);
    p.say(dim(`  ${sharedStore(provider.id)}`));
    return;
  }

  p.say('Your conversations currently live inside whichever account created them.');
  p.say('This moves them all into one place every account reads from:');
  p.say(`  ${dim(sharedStore(provider.id))}\n`);
  p.say(dim('Preview (nothing is written yet):\n'));

  const preview = new Map<string, string>();
  let risky = 0;
  for (const a of accounts) {
    const actions = linkAccount(provider, a, { dryRun: true, storeState: preview }).filter(
      (act) => act.action !== 'skipped',
    );
    // Entries already pointing at the store are the common case once one
    // account has been linked; listing each of them buries the ones that move.
    const settled = actions.filter((act) => act.action === 'already-linked').length;
    const changing = actions.filter((act) => act.action !== 'already-linked');

    p.say(`  ${bold(a.id)}`);
    if (settled) p.say(dim(`    ${settled} entries already pooled`));
    for (const act of changing) {
      if (act.action === 'overwritten-by-store') risky++;
      const mark = act.action === 'overwritten-by-store' ? yellow('!') : dim('·');
      p.say(`    ${mark} ${act.entry.padEnd(16)} ${dim(act.action)}`);
    }
    if (!actions.length) p.say(dim('    nothing to move'));
  }

  p.say(`\n${dim(`Everything is backed up to ${appHome()}/backups first.`)}`);
  p.say(dim(`Reversible at any time with \`baton unlink <account>\`.`));
  if (risky) {
    p.say(yellow(`${risky} file(s) can't be combined — the first copy wins, the other is kept as a backup.`));
  }

  if (await p.confirm('\nGo ahead?')) {
    const real = new Map<string, string>();
    for (const a of accounts) linkAccount(provider, a, { storeState: real });
    p.say(green('\n✓ History pooled. Every account now shares it.'));
  } else {
    p.say(dim('Skipped. Your accounts stay independent — `baton link --all` does this later.'));
  }
}

async function bindEditorsStep(
  provider: Provider,
  accounts: Account[],
  report: ProviderReport,
  p: SetupPrompt,
): Promise<void> {
  if (!accounts.length) {
    p.say(dim('No accounts to point them at yet. Come back after `baton add <name>`.'));
    return;
  }

  p.say(dim('Which account should each editor start on?\n'));
  const options = accounts
    .map((a, i) => `${i + 1}) ${a.id}${a.email ? '' : ' (draft)'}`)
    .join('  ');

  for (const host of report.hosts) {
    const live = liveOn(report, host.id);
    p.say(`${bold(host.label)}  ${dim(`currently: ${host.accountId ?? 'default'}`)}`);
    if (host.extensionInstalled === false) {
      p.say(dim(`  no ${provider.label} extension here — the setting still applies to its terminal`));
    }
    if (live.length) {
      p.say(yellow(`  ${live.length} session(s) running here (pid ${live.map((s) => s.pid).join(', ')}).`));
      p.say(dim('  A running session keeps the credentials it started with until the window is reloaded.'));
    }

    const pick = await p.ask(`  ${options}  ${dim('[Enter to keep]')} `);
    if (!pick) continue;

    const chosen = accounts[Number(pick) - 1];
    if (!chosen) {
      p.say(yellow('  Not a valid choice, keeping what it had.'));
      continue;
    }
    if (chosen.configDir === host.configDir) {
      p.say(dim('  Already on that account.'));
      continue;
    }
    if (!chosen.email && !(await p.confirm(`  ${bold(chosen.id)} has never been logged into. Point ${host.label} at it anyway?`))) {
      continue;
    }
    if (live.length && !(await p.confirm(`  Switch ${host.label} while ${live.length} session(s) are running?`))) {
      p.say(dim('  Left alone. Reload or close those windows, then `baton use` when you are ready.'));
      continue;
    }

    const wasOn = accounts.find((a) => a.configDir === host.configDir);
    p.say(dim(`  Will write ${provider.envVar}="${chosen.configDir}" into ${host.configFile}`));
    p.say(dim(`  The file is backed up to ${appHome()}/backups first.`));
    if (!(await p.confirm('  Apply?'))) {
      p.say(dim('  Skipped.'));
      continue;
    }

    // The Host from discovery is what bindHost writes through; the report is a
    // flattened copy of it.
    const real = provider.discoverHosts().find((h) => h.id === host.id);
    if (!real) {
      p.say(yellow('  That editor disappeared between the scan and now. Skipped.'));
      continue;
    }
    switchHost(provider, real, chosen, accounts);
    p.say(`  ${green('✓')} ${host.label} → ${chosen.id}${wasOn ? dim(` (was ${wasOn.id})`) : ''}`);
  }
}

function liveOn(report: ProviderReport, hostId: string) {
  return report.hosts.find((h) => h.id === hostId)?.liveSessions ?? [];
}

/**
 * The fallback when no editor is installed, and the thing that used to be a
 * dead end. Terminal-only use is a supported way to run Baton, not a
 * consolation prize, so it gets a real step.
 */
async function terminalStep(
  provider: Provider,
  accounts: Account[],
  p: SetupPrompt,
  opts: SetupOptions,
  isOnlyRoute: boolean,
): Promise<void> {
  if (opts.terminalStep) {
    await opts.terminalStep({ ...p, provider, accounts, isOnlyRoute });
    return;
  }

  const example = accounts.find((a) => !a.isDefault) ?? accounts[0];
  const dir = example?.configDir ?? accountDirFor('work', provider.id);

  p.say('Editors are optional. The variable is all that selects an account,');
  p.say('so exporting it in your shell is a complete setup on its own.\n');
  p.say(`  ${bold('zsh')} ${dim('(~/.zshrc)')} or ${bold('bash')} ${dim('(~/.bashrc)')}`);
  p.say(`    ${cyan(`export ${provider.envVar}="${dir}"`)}`);
  p.say(`  ${bold('fish')} ${dim('(~/.config/fish/config.fish)')}`);
  p.say(`    ${cyan(`set -gx ${provider.envVar} "${dir}"`)}\n`);
  p.say('Open a new shell and the CLI runs as that account.');
  p.say(`For one command only, set it inline: ${cyan(loginHint(provider, dir))}`);
  p.say(dim('Switching accounts from the terminal means changing that one line.'));
}

// ------------------------------------------------------------------ driver

/**
 * The guided walkthrough.
 *
 * Preferred entry point. It opens with the preflight report, walks every
 * installed provider rather than assuming the first one, and always ends with a
 * next step — including on a machine with no editors at all.
 */
export async function runGuidedSetup(opts: SetupOptions = {}): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // A question asked after stdin closes never resolves, which would hang the
  // walkthrough on `baton setup < /dev/null` or a piped run. Closed input reads
  // as an empty answer instead, so every remaining step declines and setup
  // still reaches its closing notes.
  // Already-ended stdin never emits 'close' on a fresh interface, so the
  // starting state has to be read directly rather than waited for.
  let closed = stdin.readableEnded || stdin.destroyed;
  rl.once('close', () => {
    closed = true;
  });
  const eof = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
  const question = async (q: string): Promise<string> => {
    if (closed) return '';
    return (await Promise.race([rl.question(q), eof])).trim();
  };

  const p: SetupPrompt = {
    ask: async (q, fallback = '') => (await question(q)) || fallback,
    confirm: async (q) => /^y(es)?$/i.test(await question(`${q} ${dim('[y/N]')} `)),
    say: (line = '') => console.log(line),
  };

  try {
    console.log(`\n${bold('Baton setup')}`);
    console.log(dim('Switch between AI coding accounts without losing your history.\n'));

    const report = preflight({ providers: opts.providers ?? PROVIDERS });
    for (const line of renderPreflight(report, { showProblems: false })) console.log(line);

    if (!(await openingProblems(report, p))) return;

    const order = orderProviders(report, opts.focus);
    for (const [i, providerReport] of order.entries()) {
      const provider = (opts.providers ?? PROVIDERS).find((x) => x.id === providerReport.id);
      if (!provider) continue;

      rule();
      console.log(
        `\n${bold(provider.label)}${order.length > 1 ? dim(`  · provider ${i + 1} of ${order.length}`) : ''}`,
      );

      const TOTAL = 3;
      let accounts = provider.discoverAccounts();

      step(1, TOTAL, 'A second account to switch to');
      accounts = await addAccountStep(provider, accounts, p);
      accounts = provider.discoverAccounts();

      // Adding an account changes pooling and binding, so re-read rather than
      // deciding from the opening scan.
      const fresh = refreshed(report, provider);

      step(2, TOTAL, 'Pooling your history into one shared store');
      await poolHistoryStep(provider, accounts, fresh, p);

      if (fresh.hosts.length) {
        step(3, TOTAL, 'Choosing a default account per editor');
        await bindEditorsStep(provider, accounts, fresh, p);
        if (await p.confirm('\nAlso set it up for your terminal?')) {
          await terminalStep(provider, accounts, p, opts, false);
        }
      } else {
        step(3, TOTAL, 'Using it from the terminal');
        p.say('No editor Baton knows about is installed, and that is fine.');
        await terminalStep(provider, accounts, p, opts, true);
      }
    }

    closingNotes(report, p);
  } finally {
    rl.close();
  }
}

/**
 * Backwards-compatible entry point.
 *
 * `baton setup` has always called this with one provider. It now walks every
 * installed provider, starting with the one it was handed.
 */
export async function runSetup(provider?: Provider): Promise<void> {
  return runGuidedSetup(provider ? { focus: provider } : {});
}

/** Show what preflight found, and stop only when continuing cannot work. */
async function openingProblems(report: PreflightReport, p: SetupPrompt): Promise<boolean> {
  const fatal = report.blockers.find((b) => b.code === 'no-provider');
  const notes = report.warnings.filter((w) => !HANDLED_CODES.has(w.code));

  for (const b of report.blockers) {
    p.say(`\n${red('✗')} ${bold(b.message)}`);
    p.say(`  ${b.action}`);
    if (b.command) p.say(`  ${cyan(b.command)}`);
  }

  if (fatal) {
    p.say(`\n${dim('Once it is installed, run')} ${cyan('baton setup')} ${dim('again and this will pick up where it left off.')}`);
    return false;
  }

  if (notes.length) {
    p.say(`\n${bold('Worth knowing')}`);
    for (const w of notes) {
      p.say(`  ${yellow('!')} ${w.message}`);
      p.say(`    ${dim(w.action)}`);
      if (w.command) p.say(`    ${cyan(w.command)}`);
    }
  }

  if (report.blockers.length && !(await p.confirm('\nContinue anyway?'))) {
    p.say(dim('Stopped. Nothing was changed.'));
    return false;
  }
  return true;
}

/** Installed providers, with the caller's preference first. */
function orderProviders(report: PreflightReport, focus?: Provider): ProviderReport[] {
  const installed = report.installedProviders;
  if (!focus) return installed;
  const first = installed.filter((r) => r.id === focus.id);
  return [...first, ...installed.filter((r) => r.id !== focus.id)];
}

/** Re-run discovery for one provider, keeping the rest of the report as it was. */
function refreshed(report: PreflightReport, provider: Provider): ProviderReport {
  const fresh = preflight({ providers: [provider], skipBackups: true });
  return fresh.providers[0] ?? report.providers.find((r) => r.id === provider.id)!;
}

function closingNotes(report: PreflightReport, p: SetupPrompt): void {
  rule();
  p.say(`\n${green(bold('Setup complete.'))}\n`);
  p.say('Day to day:');
  p.say(`  ${cyan('baton status')}              ${dim('see what points where')}`);
  p.say(`  ${cyan('baton use <account> --all')}  ${dim('switch every editor')}`);
  p.say(`  ${cyan('baton doctor')}              ${dim('re-run these checks any time')}`);

  const resume = `${report.installedProviders[0]?.processName ?? 'claude'} --resume`;
  if (report.editorCount) {
    p.say(`\n${yellow('After a switch, reload the editor window')}, then ${cyan(resume)}.`);
  } else {
    p.say(`\n${yellow('After changing the variable, open a new shell')}, then ${cyan(resume)}.`);
  }
  p.say(dim('Your conversations are all still there — that is the point.\n'));
}
