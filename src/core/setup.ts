import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { linkAccount } from './share.ts';
import { switchHost } from './switch.ts';
import { sharedStore, appHome } from './paths.ts';
import type { Account, Provider } from './types.ts';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const rule = () => console.log(dim('─'.repeat(64)));

function step(n: number, total: number, title: string): void {
  console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(title)}`);
  rule();
}

/** Directory a new named account would live in. */
export function accountDirFor(name: string): string {
  return path.join(os.homedir(), `.claude-${name.replace(/^\.?(claude-?)?/, '')}`);
}

/**
 * Create an empty config dir for a new account. The provider's CLI does the
 * actual login; Baton only makes the directory it will log in to, so no
 * credential ever passes through here.
 */
export function createAccount(provider: Provider, name: string): string {
  const dir = accountDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loginHint(provider: Provider, dir: string): string {
  return `${provider.envVar}="${dir}" claude`;
}

export async function runSetup(provider: Provider): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, fallback = '') => (await rl.question(q)).trim() || fallback;
  const confirm = async (q: string) => /^y(es)?$/i.test(await ask(`${q} ${dim('[y/N]')} `));

  try {
    console.log(`\n${bold('Baton setup')}`);
    console.log(dim('Switch between AI coding accounts without losing your history.\n'));

    const TOTAL = 4;

    // ---------------------------------------------------------------- 1
    step(1, TOTAL, 'Finding your accounts and editors');
    let accounts = provider.discoverAccounts();
    const hosts = provider.discoverHosts();

    if (!hosts.length) {
      console.log(yellow('No supported editors found.'));
      console.log(dim('Baton looks for VS Code, Cursor, Antigravity, Windsurf, VSCodium and Trae.'));
      return;
    }

    console.log(`Accounts for ${bold(provider.label)}:`);
    for (const a of accounts) {
      console.log(`  ${green('•')} ${bold(a.id.padEnd(16))}${dim(a.email ?? 'not logged in')}`);
    }
    if (!accounts.length) console.log(dim('  none yet'));

    console.log(`\nEditors:`);
    for (const h of hosts) {
      const acct = accounts.find((a) => a.configDir === h.configDir);
      console.log(`  ${green('•')} ${h.label.padEnd(16)}${dim(acct?.id ?? 'using the default account')}`);
    }

    // ---------------------------------------------------------------- 2
    step(2, TOTAL, 'Adding a second account');
    if (accounts.length >= 2) {
      console.log(`You already have ${bold(String(accounts.length))} accounts. ${dim('Skipping.')}`);
    } else {
      console.log('Baton needs at least two accounts to switch between.');
      console.log(dim('Each account is its own config directory with its own login.\n'));

      if (await confirm('Create one now?')) {
        const name = await ask(`Short name ${dim('(e.g. work, personal)')}: `, 'second');
        const dir = createAccount(provider, name);
        console.log(`\n${green('✓')} Created ${dir}`);
        console.log(`\nNow log into it in a ${bold('separate terminal')}:`);
        console.log(`  ${cyan(loginHint(provider, dir))}`);
        console.log(dim('  …then run /login inside it, and come back here.\n'));
        await ask(dim('Press Enter once you have logged in… '));
        accounts = provider.discoverAccounts();
      } else {
        console.log(dim('Skipped. Re-run `baton setup` once you have a second account.'));
      }
    }

    // ---------------------------------------------------------------- 3
    step(3, TOTAL, 'Pooling your history into one shared store');
    console.log('Your conversations currently live inside whichever account created them.');
    console.log('This moves them all into one place every account reads from:');
    console.log(`  ${dim(sharedStore(provider.id))}\n`);
    console.log(dim('Preview (nothing is written yet):\n'));

    const preview = new Map<string, string>();
    let risky = 0;
    for (const a of accounts) {
      console.log(`  ${bold(a.id)}`);
      for (const act of linkAccount(provider, a, { dryRun: true, storeState: preview })) {
        if (act.action === 'skipped') continue;
        if (act.action === 'overwritten-by-store') risky++;
        const mark = act.action === 'overwritten-by-store' ? yellow('!') : dim('·');
        console.log(`    ${mark} ${act.entry.padEnd(16)} ${dim(act.action)}`);
      }
    }
    console.log(`\n${dim(`Everything is backed up to ${appHome()}/backups first.`)}`);
    if (risky) console.log(yellow(`${risky} file(s) can't be combined — the first copy wins, the other is kept as a backup.`));

    if (await confirm('\nGo ahead?')) {
      const real = new Map<string, string>();
      for (const a of accounts) linkAccount(provider, a, { storeState: real });
      console.log(green('\n✓ History pooled. Every account now shares it.'));
    } else {
      console.log(dim('Skipped. Your accounts stay independent.'));
    }

    // ---------------------------------------------------------------- 4
    step(4, TOTAL, 'Choosing a default account per editor');
    console.log(dim('Which account should each editor start on?\n'));
    for (const host of hosts) {
      const current = accounts.find((a) => a.configDir === host.configDir);
      const options = accounts.map((a, i) => `${i + 1}) ${a.id}`).join('  ');
      console.log(`${bold(host.label)}  ${dim(`currently: ${current?.id ?? 'default'}`)}`);
      const pick = await ask(`  ${options}  ${dim('[Enter to keep]')} `);
      if (!pick) continue;
      const chosen = accounts[Number(pick) - 1];
      if (!chosen) {
        console.log(yellow('  Not a valid choice, keeping what it had.'));
        continue;
      }
      switchHost(provider, host, chosen, accounts);
      console.log(`  ${green('✓')} ${host.label} → ${chosen.id}`);
    }

    rule();
    console.log(`\n${green(bold('Setup complete.'))}\n`);
    console.log('Day to day:');
    console.log(`  ${cyan('baton status')}              ${dim('see what points where')}`);
    console.log(`  ${cyan('baton use <account> --all')}  ${dim('switch every editor')}`);
    console.log(`\n${yellow('After a switch, reload the editor window')}, then ${cyan('claude --resume')}.`);
    console.log(dim('Your conversations are all still there — that is the point.\n'));
  } finally {
    rl.close();
  }
}
