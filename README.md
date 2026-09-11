# Baton

Switch between multiple AI coding accounts across your editors, keeping **one shared conversation history**.

When a subscription hits its limit mid-task, pass the baton: point the editor at another account, reload the window, and `--resume` the exact same conversation. No re-explaining context, no manually editing config paths.

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

## Quick start

**Requires Node 22.18+** (for native TypeScript execution). Check with `node --version`.

```bash
git clone https://github.com/nishanprime/baton.git
cd baton
pnpm install
node src/cli.ts setup
```

`setup` is a guided walkthrough. It:

1. Finds your accounts and editors, and shows what points where.
2. Offers to create a second account if you only have one, and tells you the exact command to log into it.
3. **Previews** the history pooling and asks before moving anything.
4. Lets you pick a default account per editor.

Nothing is written until you confirm, and everything it touches is backed up to `~/.baton/backups/<timestamp>/` first.

Optionally put it on your PATH:

```bash
npm link      # then just `baton setup`
```

## Everyday use

```bash
baton status                   # accounts, editors, and what points where
baton use work --host cursor # point one editor at an account
baton use work --all         # every editor at once
baton add work                 # create a new account directory to log into
baton doctor                   # find half-applied or inconsistent bindings
baton unlink <account>         # turn the symlinks back into real files
```

Every writing command takes `--dry-run`, which prints exactly what would change and writes nothing. `--json` gives machine-readable output — it is how the GUI drives the CLI.

After a switch, **reload the editor window**, then `claude --resume`. The running process holds its token in memory, so it needs the reload — but your conversations are all still there.

## Menu bar app

A Tauri menu bar app wraps the same CLI: switch accounts from the tray, or open a window to assign accounts per editor.

```bash
pnpm gui:dev      # run it
pnpm gui:build    # produce Baton.app + a .dmg
```

Building it needs [Rust](https://rustup.rs). The app still shells out to Node, so Node stays a requirement — the CLI is bundled into the app as a single file, so there is nothing else to install.

> On macOS a GUI app launched from Finder gets a minimal `PATH` and cannot see Homebrew or nvm installs. Baton asks your login shell where Node is. If that ever fails, set `BATON_NODE` to the absolute path.

## Supported

| Provider | Status |
|---|---|
| Claude Code | ✅ |

Editors: VS Code (+ Insiders), Cursor, Antigravity, Windsurf, VSCodium, Trae.

## Adding a provider

Nothing outside `src/providers/` is Claude-specific. A provider implements [`Provider`](src/core/types.ts) — an env var, how to find its accounts, and which files are shared vs private — then gets listed in [`src/core/registry.ts`](src/core/registry.ts). Editor binding is already generic: `discoverVsCodeHosts` / `bindVsCodeHost` work for any agent shipping a VS Code extension.

The `SharePolicy` split is **default-deny**: anything not explicitly listed as shared stays private, so a key a provider adds in a future release never leaks between accounts.

## Roadmap

- Auto-detect limit exhaustion from `policy-limits.json` and offer to switch
- Bundle Node as a Tauri sidecar so the app has no external requirement
- Per-project account pinning
- Signed and notarised release builds

## Note

Check your provider's terms before rotating accounts to extend daily capacity — some restrict it, even across subscriptions you've paid for separately.

## License

MIT
