# Baton — open work

Rewritten 2026-09-11, against commit `650d44c` **plus the uncommitted work in
the tree at the time** — the GUI and several CLI fixes were landing while this
was written, so a few of these were open for an hour and closed before the
paragraph about them was finished. Everything below was checked by running the
command or reading the code that implements it; nothing is listed as done on the
strength of a commit message. Where a claim could not be verified on this
machine, it says so.

Where the project stands: `tsc --noEmit` is clean and the suite is 244 tests,
242 passing, 2 skipped because fish is not installed here. The CLI is the
complete surface. The GUI is the younger half and is being built in a parallel
pass; it now has accounts, editors, history, usage, backups and settings, and it
shows the CLI's own dry run before anything destructive.

---

## 1. Done since the last pass

Delete this section once it stops being news. It is here because the previous
backlog called all of it missing.

| Was open | Now |
|---|---|
| Terminal support (entirely missing) | `shell`, `exec`, `env`, `init` for zsh/bash/fish, completions, `baton_prompt` |
| Account lifecycle | `draft`/`active`/`idle`/`spent`, per-account login command, `reauth`, `rename`, `remove` that keeps history and refuses when it should |
| Account health | `baton health`, every unknown carrying its reason, `UNAVAILABLE_FIELDS` naming what is not knowable at all |
| Backups growing without bound | Operation-scoped snapshots with manifests, automatic retention, `backups` / `prune` / `restore`, restore itself undoable |
| Usage backend with no surface | `baton usage`, per model, priced at published API rates, `--project` / `--since` / `--until`, mtime-cached |
| Setup dead-ends on a fresh machine | Preflight-first, walks every installed provider, verifies the login happened, always ends on a next step including terminal-only |
| No way out | `baton uninstall` materialises the store back into every account first; `--dry-run`, refuses without `--yes` |
| Per-project pinning | `baton pin` / `baton unpin`, nearest ancestor wins, advisory |
| No Node in the `.dmg` | `pnpm gui:build:standalone` bundles it as a sidecar (~120MB vs ~4MB) |
| Session → account never recorded | `attribution.ts`, fed by `status`, `sessions` and `autoswitch` |
| Windows live sessions invisible | Detected via PowerShell; account reported as unknown rather than guessed |
| Tray built once, no current account | Rebuilds on `accounts-changed`, marks the account in use |
| Pooling could lose files silently | Folding an account in asserts the store never ends with fewer files |
| Limit events only visible in the app | Desktop notification on limit and on switch, best effort, never fails the switch |
| Terminal invisible to `status` | `status` shows the account this shell is on, and what is running |
| Untested modules | Tests for backups, health, lifecycle, limits, pins, preflight, pricing, settings, terminal, usage, plus one that imports every module |

Four bugs found and fixed during this pass, kept here because each says
something about where the next one will be: the shell function evaluated
`baton use`'s human output; the completions called `accounts --ids`, which did
not exist; editor binding still wrote manifest-less backups through the old
`backupFile`; and `baton preflight` printed a JavaScript array. All four were in
code paths no test exercised — see §2.2.

---

## 2. Still open

### 2.1 `setup` pools without opening a snapshot

`setup.ts:246` calls `linkAccount` in a loop with no `withSnapshot` around it,
so a first-run pooling writes one snapshot directory per backed-up entry rather
than one for the operation. `cmdLink` wraps itself correctly; the walkthrough
does not. Each snapshot has a manifest and is restorable, so this is untidy
rather than dangerous — but it is the same shape the retention work set out to
remove, and first-run is when the copies are largest.

### 2.2 The commands that write are untested

- Nothing covers `sessions.ts` on either platform, and the Windows path has
  never been run on Windows.
- CI runs every read-only command with `--json` for a zero exit and
  `node --check`s the GUI frontend. That is a smoke test: it asserts nothing
  about the output. Nothing exercises `use`, `remove`, `rename`, `unlink`,
  `uninstall`, `alias`, `backups prune`/`restore`, or the terminal commands
  `env`, `init`, `shell`, `exec` — which is exactly where all four bugs in §1
  were living.
- The two skipped tests are the fish ones. They skip when fish is absent, which
  it is here, so fish quoting is unexercised on this machine.

### 2.3 Attribution only advances when Baton runs

`recordObservation` is now called from `status`, `sessions` and `autoswitch`,
which is enough for ordinary use. There is still no daemon, so a machine where
nobody runs a Baton command records nothing, and a session that starts and ends
between two invocations is never seen. That is a real limit on how complete the
map can be, and the UI should not imply it is a log.

### 2.4 "Money saved vs API" is still unbuilt

`baton usage` gives the API-equivalent figure honestly. The comparison people
actually want — that minus what the subscriptions cost — needs one input Baton
does not have and cannot discover: what the user pays. It needs a setting and a
sentence saying the number is only as good as what they typed. Better unbuilt
than guessed.

### 2.5 GUI

Owned by a parallel pass and moving hourly, so this is deliberately short and
should be re-checked before anything is added to it. As of writing, the window
covers accounts (including login, re-auth, alias, reveal and removal with its
dry run), editors, history, usage, backups (prune and restore, both previewed)
and settings. What has no window at all: first-run setup, pins, `rename` (the
GUI's "rename" is the cosmetic alias), `exec`, and `uninstall`. A GUI-only user
therefore never sees pooling explained, only its result.

### 2.6 Packaging

- Signing and notarisation are not done, and there is no written explanation of
  the Gatekeeper warning for someone handed a `.dmg`.
- The stray `/Applications/Baton.app` from the DMG step was reported in the
  previous pass and has **not** been re-verified here.

---

## 3. Worth doing, not asked for

- Menu-bar-first UX. It is still a window that happens to have a tray icon.
- Export/import Baton config for a second machine.
- `history --search` matches conversation titles and project names only.
  Full-text search over transcripts is a different and much heavier feature; say
  which one it is rather than letting a user assume.
- `keepCount` is a floor, not a ceiling — 14 snapshots survive a policy of 10
  here because nothing is over the size or age budget, and `maxCount` is off by
  default. That is the intended reading of "a backup you cannot restore from is
  worse than the disk it saves", but it surprises people. Say it in
  `baton backups`.

---

## 4. Hard limitations — do not promise these

Properties of the data, not missing effort. State them in the UI.

1. **Editor attribution in history is impossible.** Transcripts record
   `entrypoint: "claude-vscode"` — the integration, not the fork. Cursor and
   Antigravity are indistinguishable. Live sessions *can* be attributed on
   POSIX, because the process path reveals the editor.
2. **Per-account attribution of existing history is impossible.** Transcripts
   never recorded the account, and pooling merged them. Fixable only going
   forward, and only while something is observing (§2.3). This is why
   `baton usage` has `--project` and `--since` but no `--account`.
3. **Plan, credit balance, renewal date and usage-against-limit are not on
   disk.** No local file carries them. `policy-limits.json` is policy
   restrictions, not usage — checked, and the first guess about it was wrong.
   Getting them would require authenticated API access, which is a deliberate
   non-goal: Baton never reads credentials.
4. **A running session cannot be switched.** It holds its token in memory; the
   window must reload. Detect and explain, don't pretend.
5. **A child process cannot change its parent shell's environment.** Switching
   the shell you are typing in is a sourced function or a new shell, never a
   subprocess. This is handled — `baton init` wraps `env`, and `use` is
   deliberately *not* intercepted because it rebinds editors, not this shell —
   but it stays on the list, because every future "just make `baton use` change
   my shell" request runs into it. It has already been implemented wrongly once.
6. **On Windows, a live session's account is unknowable.** Reading another
   process's environment needs debug-level access to its PEB. The command line
   still identifies the editor, so the session is reported with a null account —
   unknown, not absent.

---

## 5. Suggested order

1. §2.2 — every bug fixed this pass was in an untested write path. That is the
   pattern, not four coincidences.
2. §2.1 — first-run pooling, while the copies are biggest.
3. §2.5 — setup in the GUI, so a window-only user understands pooling before it
   happens rather than after.
4. §2.3 and §2.4 — say what the attribution map is, and either build the cost
   comparison with a real input or drop the idea.
5. §2.6 — packaging, once there is someone to hand a build to.

---

## 6. Machine state to be aware of

- History is pooled for **3 of 5** accounts: `~/.claude`, `~/.claude-work` and
  `~/.claude-personal` symlink into `~/.baton/shared/claude`. The two
  drafts have nothing to pool.
- Two draft accounts are still here and unusable: `~/.claude-test` and
  `~/.claude-testing new` (the space in that one breaks naive path handling —
  which makes it a useful test fixture, an argument for keeping one of them).
- Both editors are on `work`, which is currently **spent**: it hit its limit
  and reports a reset time.
- Backups: 18 snapshots, 258MB, of which **16 have no manifest** — they predate
  the retention work, so they list as degraded and cannot be restored
  path-by-path. The two labelled `switch:work` are the new shape: one
  directory per operation, every entry in it, restorable. Nothing is over
  budget, so nothing prunes the old ones automatically.
- Nine transcripts were lost and restored during the pooling fix (`6e17b7e`).
  The pre-Baton backup that made that recovery possible was in a session
  scratchpad; if a durable copy has not been made yet, make one.
