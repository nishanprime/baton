<img src="docs/assets/banner.svg" alt="Baton — switch AI coding accounts without losing your history" width="100%">

<p>
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%3E%3D22.18-brightgreen">
  <img alt="macOS, Linux, Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey">
</p>

Switch between multiple AI coding accounts — in your editors and in your terminal — keeping **one shared conversation history**.

When a subscription hits its limit mid-task, pass the baton: point at another account, reload the window, and `--resume` the exact same conversation. No re-explaining context, no manually editing config paths.

```bash
git clone https://github.com/nishanprime/baton.git
cd baton && pnpm start
```

`pnpm start` checks what your machine needs, installs what is missing, and opens the app. It offers to install Rust for the desktop app; decline and you get a working command line rather than an error. Needs [Node 22.18+](https://nodejs.org).

Everything it does is previewed before it happens, every writing command takes `--dry-run`, and `baton uninstall` puts every file back.

> **Installing a `.dmg` someone sent you?** It is not notarised, so macOS blocks it with a misleading "damaged" dialog. [docs/INSTALL.md](docs/INSTALL.md) explains why and what to do. Building from source avoids it entirely.

## The problem

Claude Code (and agents like it) pick their account from a config directory named by an environment variable — `CLAUDE_CONFIG_DIR`. Point it somewhere else and you get a different logged-in account. That much works today.

What doesn't work is everything around it:

- Each editor stores that variable in **two** separate settings keys. Set one and forget the other, and you get a half-applied switch where the terminal and the extension panel disagree.
- Conversation history lives *inside* the config directory. Switch accounts and your history, recent files and `--resume` list vanish — they're still on disk, just under the account you left.
- Every switch means hand-editing JSON in each editor and restarting things.

## The fix

Baton splits a config directory into two halves:

- **History is shared.** `projects/`, prompt history, checkpoints, settings and `CLAUDE.md` are moved once into a single store at `~/.baton/shared/<provider>/` and symlinked back into every account. After that, history never moves again — every account reads and writes the same one.
- **Identity stays private.** Credentials, rate-limit state and account metadata never leave their own directory.

So switching accounts is only ever a change of identity. Your work stays exactly where it was.

**Baton never reads or writes your credentials.** On macOS those live in the system Keychain, keyed per config directory; elsewhere they're a file inside it. Either way they travel with the directory on their own — Baton just changes which directory is selected.

## Install

```bash
git clone https://github.com/nishanprime/baton.git
cd baton
pnpm install
node src/cli.ts setup
```

`setup` is a guided walkthrough. It:

1. Opens with the preflight report — what is installed, what was found, what is running.
2. Walks every installed provider, not just the first.
3. Offers to create a second account, gives you the exact command to log into it, and **checks that the login actually happened** before moving on.
4. **Previews** the history pooling and asks before moving anything.
5. Ends with a next step either way: editors get a default account each, and a machine with no editors gets the terminal setup instead of a dead end.

Nothing is written until you confirm, and everything it touches is snapshotted first.

Optionally put it on your PATH:

```bash
npm link      # then just `baton setup`
```

## Everyday use

```bash
baton status                   # accounts, editors, this terminal, what is running
baton accounts                 # each account's state and its next action
baton use work --host cursor # point one editor at an account
baton use work --all         # every editor at once
baton doctor                   # find half-applied or inconsistent bindings
baton preflight                # what is installed, found, and running
baton history --project code   # browse the pooled conversations, 50 per page
```

`history` takes `--search`, `--project`, `--from`, `--limit` and `--offset`; `--search` matches conversation titles and project names, not transcript contents.

Every writing command takes `--dry-run`, which prints exactly what would change and writes nothing. `--json` gives machine-readable output on every command — it is how the GUI drives the CLI. `baton help` lists everything.

After a switch, **reload the editor window**, then `claude --resume`. The running process holds its token in memory, so it needs the reload — but your conversations are all still there.

## The terminal

The terminal is a first-class surface, not an afterthought. It actually fits the mechanism better than an editor does: there is no settings file to rewrite, only a variable to set.

```bash
baton shell work                 # interactive subshell bound to an account; exit to return
baton exec work -- claude -p hi  # one command under an account
baton env work                   # prints the exports; eval them to apply
baton init zsh                   # shell integration (zsh | bash | fish)
```

### The constraint

**A child process cannot change the environment of the shell that started it.** No CLI can. So `baton shell` and `baton exec` give you a *new* process on that account, and changing the shell you are already typing in takes one of these:

```bash
eval "$(baton env work)"                  # zsh, bash
baton env work --shell fish | source      # fish
```

Or install the shell integration once, which wraps that eval in a function:

```bash
baton init zsh >> ~/.zshrc          # bash: ~/.bash_profile on macOS, ~/.bashrc elsewhere
baton init fish >> ~/.config/fish/config.fish
```

With it loaded, `baton env work` applies to the current shell instead of printing to it, and you get account-name completions and a `baton_prompt` helper. Only `env` is intercepted: `use` rebinds editors rather than this shell, so it is passed through to the real binary untouched.

```bash
PROMPT='$(baton_prompt) '"$PROMPT"     # zsh, with setopt PROMPT_SUBST → [work] ~/code %
```

A shell on an account carries `BATON_ACCOUNT` and `BATON_PROVIDER` alongside the provider's own variable, so anything you write can see which account it is on.

### Pinning a directory

An editor binds one account for the whole application, which is the wrong granularity when one account is for client work and another is for personal projects.

```bash
baton pin clientco ~/work    # covers ~/work and everything under it
baton shell                  # in ~/work/repo: starts on clientco, no argument needed
baton pin                    # list pins, and what this directory resolves to
baton unpin ~/work
```

The nearest ancestor pin wins, so a deeper pin overrides a broader one. Pins are **advisory** — they resolve a default. Nothing enforces them, because enforcing would mean intercepting every launch.

## Accounts

An account is a config directory plus whatever identity has been logged into it. `baton accounts` reports each one's state, why it is in that state, and what to do next.

| State | Means |
|---|---|
| `draft` | The directory exists but nothing has ever logged in. Not usable yet. |
| `active` | Logged in, and an editor or a live session is on it. |
| `idle` | Logged in, bound to nothing. |
| `spent` | Logged in, and out of quota for now. |

```bash
baton add work                # create the directory to log into
baton reauth work             # the exact command to log this account in
baton alias work "Work"       # cosmetic display name, for screenshots
baton rename work clientco    # move the config directory itself
baton remove work             # delete the account; history is kept
```

`alias` and `rename` are different operations, and the cheap one is usually the one you want. An alias changes what Baton prints and touches no path at all. A rename moves the directory on disk: run it once to see the plan — what points at the old path, which editors and settings keys name it, what is running — and again with `--confirm` to apply. The shared-history symlinks survive the move because Baton writes them absolute; the references held elsewhere do not, so the plan lists them and tells you the `baton use` line that re-points each editor.

**Every account has its own login command**, because it names that account's directory:

```
CLAUDE_CONFIG_DIR='/Users/you/.claude-work' claude
```

A generic "run `/login`" is useless when two accounts both need it. `baton accounts`, `baton reauth` and `baton doctor` all print the per-account version, ready to paste. Baton never sees the credential — the provider's own CLI does the login, into the directory the variable names.

### Removing

`baton remove <account>` deletes the account directory and **keeps your conversations**. History is pooled and a transcript does not record which account wrote it, so a removal can never be allowed to reach the shared store — it detaches the account's shared entries first, so the store is not even reachable through a symlink while the directory is torn down. Anything that was never pooled is copied into the snapshot before it goes.

It snapshots first, and refuses when it should:

- Refusals that `--force` can override: live sessions on the account, or removing the directory the provider falls back to when the variable is unset.
- Refusals that nothing can override: anything that resolves to the shared store, your home directory, or a filesystem root.

`--delete-history` opts into deleting the account's own history; even then the shared store is out of scope by construction. `--dry-run` shows the whole plan first.

## Backups

Baton takes a snapshot before anything destructive — every switch, link, merge and removal. One snapshot per operation, with a manifest recording where each copied path came from, which is what makes a restore possible at all.

```bash
baton backups                 # snapshots, sizes, and the retention policy
baton backups prune           # apply retention now (--dry-run to preview)
baton backups restore <id>    # put a snapshot back (--dry-run to preview)
```

Retention runs automatically after anything destructive, and applies in this order: **keep the newest `keepCount` whatever else the budget says**, then drop by total size, then by age. A backup you cannot restore from is worse than the disk it saves.

| Setting | Default | Means |
|---|---|---|
| `backups.keepCount` | 10 | Newest snapshots always kept |
| `backups.maxTotalMb` | 500 | Total budget for `~/.baton/backups` |
| `backups.maxAgeDays` | 14 | Older snapshots dropped, subject to `keepCount` |

```bash
baton settings set backups.maxTotalMb 200
```

**Restore is itself undoable**: it takes a pre-restore snapshot before writing anything back, so restoring the wrong one is one more `baton backups restore` away from being undone.

Snapshots taken before manifests existed still list, with their entries rebuilt from disk and flagged `(no manifest)`. They can be pruned; they cannot be restored path-by-path.

## Usage and cost

```bash
baton usage
baton usage --project code --since 2026-08-01 --until 2026-09-01
```

Reads every transcript in the pooled store and totals input, output, cache-write and cache-read tokens per model, then prices them at **published first-party API rates** — what this work *would have cost* on the API instead of a subscription. It is an API-equivalent figure, not a bill and not what you paid.

- Rates live in [`src/providers/claude/pricing.ts`](src/providers/claude/pricing.ts), as published 2026-06, in USD per million tokens. Cache writes bill at 1.25x input and cache reads at 0.1x, except where a model publishes its own cache-read rate. Edit that file to refresh them.
- Partner platforms (Bedrock, Vertex) price differently and are not modelled.
- A model with no known rate still has its tokens counted and is shown as `unpriced` rather than silently priced as zero.
- `--project` (as the history listing spells it), `--since` and `--until` narrow the window. There is no `--account`: totals always cover **all accounts together**, because a transcript never recorded which account wrote it and pooling merged them. See the note under Health.

Results are cached by file mtime and size, so a second run only re-reads what changed.

## Health

```bash
baton health
```

Per account: whether a limit was hit recently and when it resets, how many sessions are live and in which editors, which editors are bound, and when it was last used. Every value carries where it came from, and every *missing* value carries **why** it is missing — not recorded yet, not applicable right now, not supported on this platform, or not knowable at all. A UI rendering this should print the reason, never a blank cell.

Four things Baton cannot tell you, because they are not on disk anywhere:

| Not knowable | Why |
|---|---|
| Plan | No local file records which plan an account is on. It is only visible to an authenticated API call, and Baton never reads credentials. |
| Credit balance | Nothing on disk carries a balance. The config directory holds settings and history, not billing state. |
| Renewal date | Billing dates live with the provider, not in the config directory. |
| Usage against the limit | No local file counts how much of a window has been consumed. `policy-limits.json` holds policy restrictions, not usage — that was checked. |

The one local signal is the provider saying in a transcript that the limit is already hit, which is what `spent` is built from. That event records the project and the error but not the account, so it is credited to whichever account is bound now — an account you already switched away from reads as `idle`, not `spent`.

Older history has the same gap: transcripts never recorded the account, and pooling merged them, so conversations from before Baton cannot be attributed. `baton sessions` writes down what the process table shows while a session is alive, which makes attribution possible from the first observation onward — never retroactively.

## When an account runs out

```bash
baton autoswitch                                  # check once and act
baton settings set autoSwitch.enabled true
baton settings set autoSwitch.mode switch         # or: notify
baton settings set autoSwitch.rotation work,spare # order to try; empty = discovery order
```

`autoswitch` looks for the provider's own "you've hit your session limit" message in the pooled history and acts on it once — the event it handled is recorded, so polling it every minute does not switch every minute. In `notify` mode (the default) it tells you and changes nothing; in `switch` mode it re-points every bound editor at the next account in the rotation. You still have to reload the window.

Either way it raises a desktop notification, because the person who needs to know is looking at an editor, not at Baton. Notifications are best effort — no notification daemon, a headless session, or permission denied never turns a successful switch into an error.

The limit event names the project and the error but not the account, so it is credited to whichever account is bound when it is read.

## The app

A Tauri menu bar app wraps the same CLI: switch accounts from the tray, or open a window to manage accounts, editors, history, usage, backups and settings.

```bash
pnpm gui:dev      # run it
pnpm gui:build    # produce Baton.app + a .dmg
```

Building it needs [Rust](https://rustup.rs). The CLI is bundled into the app as a single file, so there is nothing else to install.

Two build modes:

| Command | Size | Node |
|---|---|---|
| `pnpm gui:build` | ~4MB | Uses the Node already on the machine |
| `pnpm gui:build:standalone` | ~120MB | Bundles a Node binary as a sidecar |

The default is for people who already have Node, which is most people running an AI coding agent. The standalone build is roughly 25x larger and is for handing someone a `.dmg` who does not — it copies your own `node`, or the one at `BATON_NODE`, and re-signs it ad-hoc so macOS does not kill it on launch.

> On macOS a GUI app launched from Finder gets a minimal `PATH` and cannot see Homebrew or nvm installs. The default build asks your login shell where Node is. If that ever fails, set `BATON_NODE` to the absolute path.

The app shells out to the CLI for everything and holds no logic of its own, so the two never disagree about what an account is, and every destructive action shows you the CLI's own dry run before it happens. The CLI is still the complete surface: first-run setup, pins, `rename`, `exec` and `uninstall` have no window yet. [BACKLOG.md](BACKLOG.md) tracks the gap.

## Undoing it

```bash
baton unlink <account>     # turn one account's symlinks back into real files
baton uninstall --dry-run  # what backing out entirely would do
baton uninstall --yes      # materialise the store back into every account
```

`uninstall` copies the shared store back into each account *before* removing anything, so backing out does not require trusting the tool a second time. Baton's own state stays at `~/.baton` for you to delete when you are sure.

Pooling is also checked as it happens: folding an account into the store asserts the store never ends up with fewer files than it started with, and stops loudly if it does.

## Supported

| Provider | Status |
|---|---|
| Claude Code | supported |

Editors: VS Code (+ Insiders), Cursor, Antigravity, Windsurf, VSCodium, Trae.

Terminal: zsh, bash, fish.

Live-session detection reads the process table — `ps` on macOS and Linux, where a process's environment is readable and the account is exact. Windows lists processes through PowerShell and identifies the editor from the command line, but cannot read another process's environment without debug-level access, so the account comes back as **unknown rather than absent**. A session you can't attribute still has to stop a silent switch under a live window.

## Adding a provider

Nothing outside `src/providers/` is Claude-specific. A provider implements [`Provider`](src/core/types.ts) — an env var, how to find its accounts, and which files are shared vs private — then gets listed in [`src/core/registry.ts`](src/core/registry.ts). Editor binding is already generic: `discoverVsCodeHosts` / `bindVsCodeHost` work for any agent shipping a VS Code extension.

The `SharePolicy` split is **default-deny**: anything not explicitly listed as shared stays private, so a key a provider adds in a future release never leaks between accounts.

## Not done yet

[BACKLOG.md](BACKLOG.md) is the honest list — what remains, what is broken, and the limitations that are properties of the data rather than missing effort.

## Note

Check your provider's terms before rotating accounts to extend daily capacity — some restrict it, even across subscriptions you've paid for separately.

## License

MIT
