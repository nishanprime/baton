# Baton — open work

Written 2026-09-11. This is the full list of what has been asked for, what is
broken, and what is not possible. Intended as the brief for a redesign pass.

**The headline:** the core logic (switching, pooling, history, usage, sessions)
is solid and tested. The **GUI is half-built** — it can switch accounts and
browse history, but it cannot delete, rename, re-authenticate, or explain an
account, and the terminal is not supported at all. Most of the work below is
surfacing capability that already exists in the core, plus one genuinely new
area (terminal).

---

## 1. What actually works today (verified against the real machine)

| Area | State |
|---|---|
| Provider abstraction | Claude implemented; nothing outside `src/providers/` is Claude-specific |
| Account discovery | Scans `~/.claude*`, reads identity, handles the `~/.claude.json` quirk |
| Editor discovery | 7 VS Code forks; detects extension presence + version |
| Switching | Rewrites both settings keys, format-preserving (JSONC, comments, trailing commas) |
| Shared history | Pooled to `~/.baton/shared/<provider>`; verified 175/175 session files preserved |
| History browse | Head/tail read + mtime cache: 1566ms → 49ms cold, 1ms warm; paginated |
| Usage + cost | Token totals per model, priced at API rates (~$25k API-equivalent on this machine) |
| Live sessions | `ps`-based; attributes running sessions to account **and** editor |
| Auto-switch | Detects `"You've hit your session limit"`; notify or switch; de-duplicated via state |
| Aliases / privacy | Display names, masked emails, `Project A/B/C`, path redaction |
| Tests | 26 passing; typecheck clean; CI on Linux/macOS/Windows |

---

## 2. Requested and not done

### 2.1 Terminal support — **entirely missing, high priority**

Everything today assumes an editor. The env-var mechanism actually fits the
terminal *better* (no settings file to rewrite). Needed:

- `baton shell <account>` — spawn a subshell with the env var set, so a tab is
  bound to an account for its lifetime
- `baton exec <account> -- <cmd>` — one-off run under an account
- `baton env <account>` — print exports for `eval "$(baton env work)"`
- Shell integration installer (`baton init zsh|bash|fish`) adding a function +
  completions, so `baton use work` can affect the *current* shell (a child
  process cannot mutate its parent's env — this needs a shell function, and
  that constraint should be stated in the docs, not worked around badly)
- Prompt/status helper so a user can see which account a tab is on
- GUI: "Open terminal on this account" button
- `baton status` should show terminal sessions as first-class, not just editors

### 2.2 Account lifecycle — the biggest UX hole

Right now an account can be created and then **nothing**. There is no delete,
no rename in the GUI, no re-auth, and a not-logged-in account says "run the
login command" without saying what it is. The user has two dead accounts
(`test`, `testing new`) on their machine from testing this.

- **Draft state** — an account dir with no identity is a *draft*, labelled as
  such, with its next action attached (not a dead "unused" tag)
- **Show the login command inline**, with copy-to-clipboard and "open terminal"
- **Re-authenticate** an existing account
- **Delete an account**, with a confirmation that offers to **preserve the chat
  history** (history is pooled and its origin account is not recorded, so
  deleting an account must never silently delete conversations)
- **Rename** (alias) from the GUI — CLI-only today
- **Reveal config dir in Finder**
- Guard: refuse to delete an account with live sessions, or warn clearly

### 2.3 Account health

Asked for: healthy / low credit / renewal date / plan.

- **Possible:** last limit event, its reset time, whether the account is
  currently spent, live session count, last used
- **Not possible without API access** (see §5): credit balance, renewal date,
  plan tier. Must be stated in the UI rather than faked or silently omitted.

### 2.4 Usage tab

Backend is built (`src/core/usage.ts`) but has no UI and no filters.

- Tab showing tokens + API-equivalent cost, per model
- **Filters: all accounts vs specific account, date range, project**
- "Money saved vs API" framed honestly: API-equivalent spend minus what
  subscriptions actually cost — needs the user to enter what they pay
- Per-account attribution is **not possible retroactively** (see §5), so either
  scope this to project/model/date, or start recording session→account going
  forward and say the data begins now

### 2.5 Setup / onboarding

- **Dead-ends on a fresh machine**: "No supported editors found" and exits, with
  no next step
- Only walks the first provider; should detect and offer all installed ones
- Never verifies that a login actually succeeded after `add`
- Doesn't check prerequisites (Node version, whether the provider CLI exists)
- Should report live sessions and warn before switching under them
- Should run inside the GUI too — first-run currently only exists in the CLI

### 2.6 Packaging

- Bundle Node as a Tauri sidecar so the `.dmg` works for someone without Node
  (today it is a hard requirement and the app just errors)
- Signing and notarisation, or clear instructions for the Gatekeeper warning
- The DMG bundling step writes a stray `/Applications/Baton.app`; `--bundles
  app` avoids it, but the release path needs a real fix

---

## 3. Bugs and rough edges found but not fixed

- **`~/.baton/backups` grows without bound** — every switch and every link backs
  up, with no pruning. Self-inflicted; needs retention (count or age) and a
  `baton backups` command to list/prune/restore.
- **Tray menu is built once at startup** — it does not refresh when accounts
  change, and does not indicate the current account.
- GUI error text is raw `Err(String)` — not actionable, no retry affordance.
- No loading states; slow calls look like a frozen window.
- No empty states (no accounts / no editors / no history).
- History search re-runs a full listing per keystroke (debounced, but wasteful).
- `default` (`~/.claude`) is confusing — it is both "the terminal fallback" and
  a normal account. Needs a clearer model, especially once terminals are real.
- Windows: live-session detection is `ps`-based and returns empty; untested
  overall.
- No tests for `sessions.ts`, `limits.ts`, `usage.ts`, `settings.ts`, or any CLI
  command. Only pure helpers are covered.
- No `baton uninstall` / reset that unlinks everything and restores standalone
  accounts.
- Accessibility: no keyboard navigation, no focus management in modals, no
  ARIA on the tab strip beyond `aria-selected`.

---

## 4. Not asked for, but worth doing

- **Record session → account going forward.** The single highest-value missing
  datum. It unlocks per-account usage, per-account history filtering, and
  accurate "which account hit the limit". Cheap to do by watching live sessions
  and writing a small map; only works prospectively.
- Menu-bar-first UX — it is currently a window that happens to have a tray icon.
- Per-project account pinning (asked for earlier, never built).
- Rotation ordering UI for auto-switch (`rotation` exists in settings, no UI).
- Notifications on limit/switch, rather than only in-app text.
- Export/import Baton config for a second machine.
- A dry-run/preview toggle in the GUI, matching the CLI's `--dry-run`.

---

## 5. Hard limitations — do not promise these

These are properties of the data, not missing effort. State them in the UI.

1. **Editor attribution in history is impossible.** Transcripts record
   `entrypoint: "claude-vscode"` — the integration, not the fork. Cursor and
   Antigravity are indistinguishable. (Live sessions *can* be attributed,
   because the process path reveals the editor.)
2. **Per-account attribution of existing history is impossible.** Transcripts
   never recorded the account, and pooling merged them. Fixable only going
   forward (§4).
3. **Plan, credit balance, and renewal date are not on disk.** No local file
   carries them. `policy-limits.json` is policy restrictions, not usage — I
   checked, and my first guess about it was wrong. Getting these would require
   authenticated API access, which is a deliberate non-goal: Baton never reads
   credentials.
4. **A running session cannot be switched.** It holds its token in memory; the
   window must reload. Detect and explain, don't pretend.
5. **A child process cannot change its parent shell's environment.** Terminal
   "switching" must be a shell function or a new shell, not a subprocess.

---

## 6. Suggested order

1. Account lifecycle (§2.2) — the most visible hole, all of it is UI over
   existing core
2. Terminal support (§2.1) — the biggest missing surface
3. Backup pruning (§3) — actively accumulating on the user's disk
4. Setup rework (§2.5) + GUI first-run
5. Usage tab (§2.4) and health (§2.3), with the limitations stated
6. Session→account recording (§4)
7. Packaging (§2.6)
8. Tests for the untested modules (§3)

---

## 7. Machine state to be aware of

- History is **already pooled** on this machine; `~/.claude`,
  `~/.claude-work`, `~/.claude-personal` symlink into
  `~/.baton/shared/claude`. 175 session files verified intact.
- Two draft accounts exist and are unusable from the GUI: `~/.claude-test`,
  `~/.claude-testing new` (note the space in that one — it will break naive
  path handling).
- Both editors are currently bound to `work`.
- A pre-Baton backup of all three config dirs is in the session scratchpad; a
  copy should be moved somewhere durable before relying on it.
