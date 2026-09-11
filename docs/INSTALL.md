# Installing Baton

Baton moves real conversation history around. Read [What it touches](#what-it-touches)
before running it anywhere you care about.

## The short version

| You are | Do this |
|---|---|
| A developer, on any platform | Clone and build. No Gatekeeper problem, and you can read what you are running. |
| Handed a `.dmg` on macOS | It is **not notarised**. macOS will refuse to open it until you clear the quarantine flag — see below. |

## Build from source (recommended)

Needs [Node 22.18+](https://nodejs.org). The GUI additionally needs [Rust](https://rustup.rs).

```bash
git clone https://github.com/nishanprime/baton.git
cd baton
pnpm install

pnpm setup     # guided walkthrough — previews everything before writing
pnpm build     # optional: builds Baton.app (needs Rust)
pnpm dev       # optional: run the app with live reload
```

Every command:

| Command | Does |
|---|---|
| `pnpm setup` | The guided walkthrough |
| `pnpm cli -- <args>` | Run the CLI, e.g. `pnpm cli -- accounts` |
| `pnpm test` | The test suite |
| `pnpm typecheck` | Types only |
| `pnpm build` / `pnpm dev` | Build or run the app (needs Rust) |
| `pnpm build:cli` | Bundle the CLI alone; no Rust needed |

There is no `build:dev` — `pnpm dev` runs the app.

An app you built yourself is not quarantined, so it opens normally.

## Installing a `.dmg` you were sent

Baton is signed ad-hoc, not with an Apple Developer ID, and is not notarised. macOS
treats a downloaded app like that as untrusted and blocks it outright — the dialog says
the app "is damaged and can't be opened", which is misleading: it is intact, just not
notarised.

To open it anyway, after dragging Baton to Applications:

```bash
xattr -dr com.apple.quarantine /Applications/Baton.app
```

Then open it normally.

**Do not run that command on software you were not expecting.** It is the exact step
malware distribution relies on. If you did not get this build from someone you trust,
build from source instead — it takes two minutes and you can read the code.

## Node

The default build is ~4MB and requires Node on your machine. If you do not have Node,
ask for the standalone build (`pnpm gui:build:standalone`), which bundles it at ~120MB.

If the app cannot find your Node — likely with an unusual version manager — set it
explicitly:

```bash
launchctl setenv BATON_NODE "$(which node)"
```

## What it touches

Worth knowing before you run it, not after.

**It reads and moves your conversation history.** Pooling relocates every transcript into
`~/.baton/shared/` and replaces the originals with symlinks. Everything is snapshotted
first, `baton link --all --dry-run` shows exactly what would move, and `baton uninstall`
puts it all back as real files.

**It rewrites your editors' `settings.json`.** Two keys only, and the file is backed up
first. Comments and formatting are preserved.

**It never reads or writes your credentials.** They stay in the macOS Keychain or in a
file inside the config directory, and travel with that directory on their own. Baton only
changes which directory is selected. `baton export` carries settings and aliases — never
tokens, and never history.

**It keeps backups, and bounds them.** Snapshots before anything destructive, pruned to
the newest 10, at most 20, under 500MB, for 14 days. `baton backups` shows them.

## Uninstalling

```bash
baton uninstall --dry-run   # see what would happen
baton uninstall --yes       # every account gets its own files back
rm -rf ~/.baton             # once you are satisfied
```

Your editors keep pointing at whichever account they were on. That is just an environment
variable and is harmless.
