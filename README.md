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

## Install

Requires Node 22.18+ (for native TypeScript execution).

```bash
git clone https://github.com/nishanprime/baton.git
cd baton && pnpm install
npm link          # optional, puts `baton` on your PATH
```

## Use

```bash
baton status                  # accounts, editors, and what points where
baton link --all              # one-time: pool all history into the shared store
baton use work --host cursor
baton use work --all        # every editor at once
baton doctor                  # find half-applied or inconsistent bindings
```

Every command that writes accepts `--dry-run`. **Run `baton link --all --dry-run` first** — it prints exactly what would move, and flags any single-value file (like `CLAUDE.md`) where one copy has to win.

Everything Baton touches is backed up to `~/.baton/backups/<timestamp>/` beforehand, and `baton unlink <account>` turns the symlinks back into real files if you ever want out.

After a switch, **reload the editor window**, then `claude --resume`. The running process holds its token in memory, so it needs the reload — but your conversations are all still there.

## Supported

| Provider | Status |
|---|---|
| Claude Code | ✅ |

Editors: VS Code (+ Insiders), Cursor, Antigravity, Windsurf, VSCodium, Trae.

## Adding a provider

Nothing outside `src/providers/` is Claude-specific. A provider implements [`Provider`](src/core/types.ts) — an env var, how to find its accounts, and which files are shared vs private — then gets listed in [`src/core/registry.ts`](src/core/registry.ts). Editor binding is already generic: `discoverVsCodeHosts` / `bindVsCodeHost` work for any agent shipping a VS Code extension.

The `SharePolicy` split is **default-deny**: anything not explicitly listed as shared stays private, so a key a provider adds in a future release never leaks between accounts.

## Roadmap

- Menu bar GUI (Tauri) — switch without a terminal
- Auto-detect limit exhaustion from `policy-limits.json` and prompt to switch
- Per-project account pinning

## Note

Check your provider's terms before rotating accounts to extend daily capacity — some restrict it, even across subscriptions you've paid for separately.

## License

MIT
