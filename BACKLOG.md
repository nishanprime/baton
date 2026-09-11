# Baton — open work

Rewritten 2026-09-11, against commit `650d44c`. Everything below was checked by
running the command or reading the code that implements it; nothing is listed as
done on the strength of a commit message. Where a claim could not be verified on
this machine, it says so.

Shape of the project right now: **the CLI is the complete surface**, `tsc
--noEmit` is clean, and the suite is 242 tests — **239 passing, 1 failing
(§2.4), 2 skipped** because fish is not installed here. The GUI is the younger
half and is being built in a parallel pass; the Rust shim already exposes
accounts, health, usage, backups, removal, re-auth, sessions and preflight, and
the window is catching up to it. `src/` was being edited while this was written,
so check the failing test before assuming it is still red.

---

## 1. Done since the last pass

Deleted from this list once it stops being news. Kept for now because the
previous backlog called all of it missing.

| Was open | Now |
|---|---|
| Terminal support (entirely missing) | `shell`, `exec`, `env`, `init` for zsh/bash/fish, with completions and a `baton_prompt` helper |
| Account lifecycle | `draft`/`active`/`idle`/`spent`, per-account login command, `reauth`, `remove` that keeps history and refuses when it should |
| Account health | `baton health`, with every unknown carrying its reason and `UNAVAILABLE_FIELDS` naming what is not knowable at all |
| Backups growing without bound | Operation-scoped snapshots with manifests, automatic retention, `backups` / `prune` / `restore`, restore itself undoable |
| Usage backend with no surface | `baton usage`, per model, priced at published API rates, mtime-cached |
| Setup dead-ends on a fresh machine | Preflight-first, walks every installed provider, verifies the login happened, always ends on a next step including terminal-only |
| No way out | `baton uninstall` materialises the store back into every account first; `--dry-run`, and refuses without `--yes` |
| Per-project pinning | `baton pin` / `baton unpin`, nearest ancestor wins, advisory |
| No Node in the `.dmg` | `pnpm gui:build:standalone` bundles it as a sidecar (~120MB vs ~4MB) |
| Session → account never recorded | `src/core/attribution.ts` records what a live session reveals, prospectively |
| Windows live sessions invisible | Detected via PowerShell; account reported as unknown rather than guessed |
| Tray built once, no current account | Rebuilds on `accounts-changed`, marks the account in use with `•` |
| Pooling could lose files silently | Folding an account in asserts the store never ends with fewer files |
| Limit events only visible inside the app | Desktop notification on limit and on switch, best effort, never fails the switch |
| Untested modules | Tests for backups, health, lifecycle, limits, pins, preflight, pricing, settings, terminal, usage, plus one that imports every module |

---

## 2. Still open

### 2.1 The shell function's `use` path is broken

`baton init zsh` installs a wrapper that intercepts `use` and `env`, captures
stdout and evals it. `env` works — verified end to end, the current shell's
`CLAUDE_CONFIG_DIR` changes. `use` does not: `cmdUse` never reads `--shell`, so
the wrapper evals human output.

```
$ eval "$(baton init zsh)"
$ baton use personal --dry-run
(eval):1: bad pattern: ^[[33m[dry-run]^[[0m
```

Without `--dry-run` it is worse than a bad error: it rewrites every editor's
settings while the user was asking about this shell.

Two honest fixes: teach `use --shell <kind>` to put the eval-able script on
stdout and everything human on stderr (the contract `terminal.ts` already
documents), or drop `use` from the wrapper's case list and let `env` be the one
that touches the shell. Until then the README documents `env`, not `use`.

### 2.2 Completions call a flag that does not exist

Both completion scripts run `baton accounts --ids`. `cmdAccounts` ignores
`--ids` and prints the full human listing, so `compadd` is fed ANSI-decorated
prose. Verified. Add the flag, or have the completion read `accounts --json`.

### 2.3 Editor binding still writes stray, unrestorable backups

`backups.ts` exports `backupEntry` as "the drop-in for the per-call timestamped
copies", but `vscode-host.ts:135` still calls the old `backupFile` from
`paths.ts`. So every switch writes a manifest-less directory beside the
operation's snapshot — the exact pattern the retention work removed everywhere
else. On disk here:

```
~/.baton/backups/2026-09-11T21-31-16-283Z/cursor-settings.json   # no manifest
```

Those list as `(no manifest)`, can be pruned, and cannot be restored
path-by-path. One-line fix; it is only unfixed because nothing failed loudly.

### 2.4 Two things wrong with preflight

**A draft account's login command names the wrong variable.** This is the one
failing test (`test/preflight.test.ts:92`). `preflight.ts:545` builds the
command by looking the provider up in the global registry and falling back to
`PROVIDERS[0]` when the id is not there:

```js
command: loginCommandForDir(PROVIDERS.find((x) => x.id === p.id) ?? PROVIDERS[0]!, a.configDir)
```

A provider passed in through `preflight({ providers })` — an injected stub, or
anything not registered — gets Claude's `CLAUDE_CONFIG_DIR` printed for it, so
the command Baton tells you to paste logs into the wrong place. Benign today
because Claude is the only registered provider, and the reason the whole
"per-account login command" feature exists is that a wrong command is worse
than no command. The report already walks provider objects; carry the provider
through instead of re-looking it up.

**The human path prints a JavaScript array.** `renderPreflight` returns
`string[]` and the CLI does `console.log` on it, so `baton preflight` dumps
`[ '\x1B[1mThis machine…', … ]` with the escape codes visible. `--json` is
fine. Join the lines — and note this is the first thing `setup` prints.

### 2.5 The terminal is not visible in `status`

`baton status` still shows only accounts and editors. `currentAccountFromEnv` is
imported by `src/cli.ts` and never called, so nothing tells you which account
the shell you are typing in is on. Live sessions are a separate command rather
than part of the picture. Terminal sessions were supposed to be first-class in
`status`, and are not.

### 2.6 Attribution only advances when someone looks

`recordObservation` has exactly one caller — `baton sessions`. Nothing polls, so
the session→account map fills in only while a human happens to run that command.
Either call it from `autoswitch` (which is already meant to be polled) and from
`status`, or give it a real watcher. Until then, "attribution begins now" is
closer to "attribution begins whenever you next run `sessions`".

### 2.7 Usage has no filters

`buildUsageReport(providers)` takes providers and nothing else. Asked for, still
missing: filter by account, date range, and project. Account is the one that
cannot be done retroactively (§4.2) — project and date can, and the data is
already read per file.

"Money saved vs API" also remains unbuilt, and needs one input Baton does not
have: what the user actually pays. It should stay unbuilt rather than guessed.

### 2.8 Rename exists in the core and nowhere else

`renameAccount` is exported from `lifecycle.ts` and imported by `src/cli.ts`,
but no command calls it. `baton alias` only sets a display name. Renaming an
account means moving its directory and re-pointing every editor, which is
exactly the sort of thing the core should do and a user should not do by hand.

### 2.9 GUI

Owned by a parallel pass and moving hourly, so this is deliberately short. As of
`8f92a86` the Rust shim is ahead of the window: commands exist for accounts,
health, usage, backups (list/prune/restore), removal, re-auth, sessions,
preflight, aliases, revealing a directory, and opening a terminal on an account.
What still needs saying regardless of who lands it:

- First-run setup exists only in the CLI. A GUI-only user never sees pooling
  explained, only its result.
- Previews are per-command rather than a mode: pooling, removal and the backup
  commands take a dry run, switching does not.
- Errors still surface as strings in a status line, with no retry affordance.

### 2.10 Packaging

- Signing and notarisation are not done, and there is no written explanation of
  the Gatekeeper warning for someone handed a `.dmg`.
- The stray `/Applications/Baton.app` from the DMG step was reported in the
  previous pass and has **not** been re-verified here.

### 2.11 Tests and platforms

- No test covers `sessions.ts` on either platform. `test/modules-load.test.ts`
  proves every module loads, which is not the same as exercising it.
- CI now runs every read-only command with `--json` for a zero exit, and
  `node --check`s the GUI frontend. That is a smoke test: it asserts nothing
  about the output. Nothing covers the commands that write — `use`, `remove`,
  `unlink`, `uninstall`, `alias`, `backups prune`/`restore` — or the terminal
  commands `env`, `init`, `shell`, `exec`, which is how §2.1 shipped broken.
- The two skipped tests are the fish ones; they skip when fish is absent, which
  it is here, so fish quoting is unexercised on this machine.
- Windows session detection has never been run on Windows.

---

## 3. Worth doing, not asked for

- Menu-bar-first UX. It is still a window that happens to have a tray icon.
- Export/import Baton config for a second machine.
- History search matches conversation titles and project names only. Full-text
  search over transcripts is a different and much heavier feature; say which one
  it is rather than letting a user assume.
- `keepCount` is a floor, not a ceiling — 14 snapshots survive a policy of 10
  because nothing is over the size or age budget, and `maxCount` is off by
  default. That is the intended reading of "a backup you cannot restore from is
  worse than the disk it saves", but it surprises people. Say it in `baton
  backups`.

---

## 4. Hard limitations — do not promise these

Properties of the data, not missing effort. State them in the UI.

1. **Editor attribution in history is impossible.** Transcripts record
   `entrypoint: "claude-vscode"` — the integration, not the fork. Cursor and
   Antigravity are indistinguishable. Live sessions *can* be attributed on
   POSIX, because the process path reveals the editor.
2. **Per-account attribution of existing history is impossible.** Transcripts
   never recorded the account, and pooling merged them. Fixable only going
   forward, and only while something is observing (§2.6).
3. **Plan, credit balance, renewal date and usage-against-limit are not on
   disk.** No local file carries them. `policy-limits.json` is policy
   restrictions, not usage — checked, and the first guess about it was wrong.
   Getting them would require authenticated API access, which is a deliberate
   non-goal: Baton never reads credentials.
4. **A running session cannot be switched.** It holds its token in memory; the
   window must reload. Detect and explain, don't pretend.
5. **A child process cannot change its parent shell's environment.** Terminal
   switching is a sourced function or a new shell, never a subprocess. This is
   handled, not worked around — but it stays on this list because every future
   "just make `baton use` change my shell" request runs into it.
6. **On Windows, a live session's account is unknowable.** Reading another
   process's environment needs debug-level access to its PEB. The command line
   still identifies the editor, so the session is reported with a null account —
   unknown, not absent.

---

## 5. Suggested order

1. §2.4 — the suite is red, and the bug under it is a command that sends a user
   to the wrong account.
2. §2.1 and §2.2 — the shell integration ships a broken command and broken
   completions today.
3. §2.3 — every switch is still writing unrestorable backups.
4. §2.5 and §2.6 — the terminal work is not finished until `status` shows it and
   attribution advances without being asked.
5. §2.7, §2.8 — usage filters and rename.
6. §2.11 — `sessions.ts` and CLI-level tests.
7. §2.10 — packaging, once there is someone to hand a build to.

---

## 6. Machine state to be aware of

- History is pooled for **3 of 5** accounts: `~/.claude`, `~/.claude-work` and
  `~/.claude-personal` symlink into `~/.baton/shared/claude`. The two
  drafts are not pooled and have nothing to pool.
- Two draft accounts are still here and unusable: `~/.claude-test` and
  `~/.claude-testing new` (the space in that one breaks naive path handling —
  it is a useful test case, which is an argument for keeping one of them).
- Both editors are on `work`, which is currently **spent** — it hit its limit
  and reports a reset time.
- Backups: 14 snapshots, 258MB, **none with a manifest** — all predate the
  retention work, so they list as degraded. Nothing is over budget.
- Nine transcripts were lost and restored during the pooling fix (`6e17b7e`).
  The pre-Baton backup that made that recovery possible was in a session
  scratchpad; if a durable copy has not been made yet, make one.
