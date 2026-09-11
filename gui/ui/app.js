// Baton's window. The Rust shim only runs the CLI and hands back its JSON, so
// every judgement about what the user sees is made here.

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

if (!window.__TAURI__?.core?.invoke) {
  $('sub').textContent = 'Tauri API unavailable';
  $('main').innerHTML =
    '<div class="empty"><b>This page has to run inside the Baton app.</b>' +
    'Open the Baton window rather than the HTML file.</div>';
  throw new Error('no tauri');
}
const { invoke } = window.__TAURI__.core;

// Per-viewer convenience only; the checklist disappears on its own once the
// steps are done, so losing this just means seeing it again.
let introDismissed = false;
try { introDismissed = localStorage.getItem('baton.introDismissed') === '1'; } catch { /* private window */ }
const { listen } = window.__TAURI__.event;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Single-quote for a shell, so a path with a space or an apostrophe survives. */
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// ---------------------------------------------------------------- formatting

function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Token counts run to eleven digits; nobody reads those. */
function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1000) return String(v);
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (Math.abs(v) >= size) {
      const s = v / size;
      return `${s < 10 ? s.toFixed(1) : Math.round(s)}${suffix}`;
    }
  }
  return String(v);
}

const fmtExact = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—');

/** null cost means no published rate — say so rather than printing $0.00. */
function fmtUsd(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function relTime(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const secs = (Date.now() - t) / 1000;
  const a = Math.abs(secs);
  if (a < 60) return 'just now';
  const [n, unit] =
    a < 3600 ? [a / 60, 'm'] :
    a < 86400 ? [a / 3600, 'h'] :
    a < 2592000 ? [a / 86400, 'd'] : [a / 2592000, 'mo'];
  const label = `${Math.round(n)}${unit}`;
  return secs >= 0 ? `${label} ago` : `in ${label}`;
}

const fmtStamp = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');

/**
 * Home as "~". Derived from an account that reports both its real directory and
 * the CLI's own shortened one, so the prefix is the CLI's, not a guess.
 */
function homeDir() {
  for (const a of provider()?.accounts ?? []) {
    if (a.displayDir?.startsWith('~') && a.configDir?.endsWith(a.displayDir.slice(1))) {
      return a.configDir.slice(0, a.configDir.length - (a.displayDir.length - 1));
    }
  }
  return null;
}

function tilde(p) {
  const home = homeDir();
  return home && String(p).startsWith(home) ? `~${String(p).slice(home.length)}` : String(p ?? '');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- CLI bridge

/**
 * Tauri maps camelCase argument keys onto snake_case Rust parameters, but the
 * shim's own spelling is not ours to assume, so multi-word keys are sent both
 * ways. A command ignores the key it did not ask for, which makes this free.
 */
function spread(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = v;
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (snake !== k) out[snake] = v;
  }
  return out;
}

/** What to tell someone to run when the app cannot do it yet. */
const CLI_FOR = {
  accounts: 'accounts',
  health: 'health',
  usage: 'usage',
  backups: 'backups',
  backups_prune: 'backups prune',
  backups_restore: 'backups restore <id>',
  remove_account: 'remove <account>',
  set_alias: 'alias <account> <name>',
  status: 'status',
  history: 'history',
  settings: 'settings',
  set_setting: 'settings set <key> <value>',
  switch_account: 'use <account>',
  add_account: 'add <name>',
  doctor: 'doctor',
  autoswitch: 'autoswitch',
  preflight: 'preflight',
  preview_link: 'link --all --dry-run',
  apply_link: 'link --all',
};

const MISSING_CMD =
  /not\s+(?:found|allowed|registered|exist)|unknown command|unrecognized command|no such command/i;

function errorText(e) {
  if (e === null || e === undefined) return 'The command failed without saying why.';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string' && e.message) return e.message;
  if (typeof e.error === 'string' && e.error) return e.error;
  try {
    const s = JSON.stringify(e);
    return s && s !== '{}' ? s : String(e);
  } catch {
    return String(e);
  }
}

/** Never surfaces a raw error object: message, command, and whether it exists. */
class CallError extends Error {
  constructor(command, cause) {
    super(errorText(cause));
    this.name = 'CallError';
    this.command = command;
    this.payload = cause && typeof cause === 'object' ? cause : null;
    this.missing = MISSING_CMD.test(this.message);
  }
}

async function call(command, args) {
  try {
    return await invoke(command, spread(args));
  } catch (e) {
    throw new CallError(command, e);
  }
}

function missingNote(command) {
  const cli = CLI_FOR[command];
  return `This build of the Baton app has no "${command}" command wired up yet.` +
    (cli ? ` The CLI still does it — run: baton ${cli}` : '');
}

const explain = (e) => (e instanceof CallError && e.missing ? missingNote(e.command) : errorText(e));

// ---------------------------------------------------------------- messages

let msgSeq = 0;
const messages = [];
/** Keys the user has dismissed. A poll on a timer must not resurrect them. */
const mutedKeys = new Set();

/**
 * A message the user can get rid of. Successes fade on their own; anything the
 * user has to act on stays until it is dismissed, and a message about one tab
 * is dropped when they leave that tab rather than following them around.
 */
function say(text, kind = 'ok', opts = {}) {
  if (opts.key) {
    if (mutedKeys.has(opts.key)) return null;
    const live = messages.find((m) => m.key === opts.key);
    if (live) return live.id;
  }
  const m = {
    id: ++msgSeq,
    key: opts.key ?? null,
    kind,
    text,
    title: opts.title ?? null,
    lines: opts.lines ?? [],
    code: opts.code ?? null,
    actions: opts.actions ?? [],
    tab: opts.global ? null : state.tab,
  };
  messages.push(m);
  if (kind === 'ok' && !opts.keep) setTimeout(() => dismissMsg(m.id), 6000);
  renderMsgs();
  return m.id;
}

const fail = (e, opts = {}) => say(explain(e), 'err', { keep: true, ...opts });

function dismissMsg(id) {
  const i = messages.findIndex((m) => m.id === id);
  if (i >= 0) {
    if (messages[i].key) mutedKeys.add(messages[i].key);
    messages.splice(i, 1);
    renderMsgs();
  }
}

function dropOtherTabMessages() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tab && messages[i].tab !== state.tab) messages.splice(i, 1);
  }
}

function renderMsgs() {
  const host = $('msgs');
  host.innerHTML = messages.map((m) => `
    <div class="msg ${esc(m.kind)}">
      <div class="grow">
        ${m.title ? `<b>${esc(m.title)}</b>` : ''}
        ${esc(m.text)}
        ${m.lines.length ? `<ul>${m.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        ${m.code ? `<div class="cmd"><code>${esc(m.code)}</code>
          <div class="actions"><button class="btn tiny" data-copy="${esc(m.code)}">Copy</button></div></div>` : ''}
        ${m.actions.length ? `<div class="actions">${m.actions.map((a, i) =>
          `<button class="btn tiny" data-act="${m.id}:${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>
      <button class="icon" data-close="${m.id}" aria-label="Dismiss this message" title="Dismiss">&times;</button>
    </div>`).join('');

  for (const b of qsa('[data-close]', host)) {
    b.onclick = () => dismissMsg(Number(b.dataset.close));
  }
  for (const b of qsa('[data-act]', host)) {
    const [id, idx] = b.dataset.act.split(':');
    const m = messages.find((x) => x.id === Number(id));
    const action = m?.actions[Number(idx)];
    if (action) b.onclick = () => busyWhile(b, () => action.run(m));
  }
}

// ---------------------------------------------------------------- busy state

/** Disables the control that started the work, so it cannot be fired twice. */
async function busyWhile(btn, fn) {
  if (btn?.disabled) return undefined;
  const label = btn ? btn.innerHTML : null;
  if (btn) {
    const word = btn.classList.contains('icon') ? '' : btn.textContent.trim();
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${esc(word)}`;
  }
  try {
    return await fn();
  } catch (e) {
    fail(e);
    return undefined;
  } finally {
    if (btn?.isConnected) {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

// ---------------------------------------------------------------- dialogs
// Tauri's webview implements neither confirm() nor prompt(): both return
// undefined without showing anything, so every question is asked in-app.

const FOCUSABLE = 'button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])';

function trapTab(e, root) {
  const items = qsa(FOCUSABLE, root).filter((x) => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Resolves to an object of the dialog's [data-field] values, or null when it
 * was cancelled — so `if (!answer) return;` reads correctly for a plain
 * confirmation. Focus moves in on open and back to the opener on close.
 */
function dialog({
  title,
  body = '',
  html = '',
  okLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
  hideOk = false,
  onOpen,
}) {
  closeMenu(false);
  return new Promise((resolve) => {
    const scrim = $('scrim');
    const modal = $('modal');
    const returnTo = document.activeElement;

    modal.innerHTML = `
      <h3 id="dlgTitle">${esc(title)}</h3>
      ${body ? `<p>${esc(body)}</p>` : ''}
      <div id="dlgBody">${html}</div>
      <div class="actions">
        <button class="btn ghost" data-dlg="cancel">${esc(cancelLabel)}</button>
        ${hideOk ? '' : `<button class="btn ${danger ? 'danger' : ''}" data-dlg="ok">${esc(okLabel)}</button>`}
      </div>`;
    modal.setAttribute('aria-labelledby', 'dlgTitle');
    scrim.classList.add('open');

    const collect = () => {
      const out = { ok: true };
      for (const f of qsa('[data-field]', modal)) {
        const key = f.dataset.field;
        if (f.type === 'checkbox') out[key] = f.checked;
        else if (f.type === 'radio') { if (f.checked) out[key] = f.value; }
        else out[key] = f.value.trim();
      }
      return out;
    };

    const close = (value) => {
      scrim.classList.remove('open');
      modal.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      scrim.onclick = null;
      if (returnTo?.isConnected) returnTo.focus();
      resolve(value);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Tab') {
        trapTab(e, modal);
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        qs('[data-dlg="ok"]', modal)?.click();
      }
    };

    document.addEventListener('keydown', onKey, true);
    scrim.onclick = (e) => { if (e.target === scrim) close(null); };
    qs('[data-dlg="cancel"]', modal).onclick = () => close(null);
    const okBtn = qs('[data-dlg="ok"]', modal);
    if (okBtn) okBtn.onclick = () => close(collect());

    onOpen?.({ modal, close, ok: okBtn });
    (qs('input:not([type=hidden]),select,textarea', modal) ?? okBtn ?? qs('[data-dlg="cancel"]', modal)).focus();
  });
}

const confirmDialog = (title, body, opts = {}) => dialog({ title, body, ...opts });

async function promptDialog(title, body, { placeholder = '', value = '', okLabel = 'Save', allowEmpty = false } = {}) {
  const answer = await dialog({
    title,
    body,
    okLabel,
    html: `<input type="text" class="wide" data-field="value" placeholder="${esc(placeholder)}" value="${esc(value)}" />`,
  });
  if (!answer) return null;
  const v = answer.value ?? '';
  return allowEmpty ? v : (v || null);
}

// ---------------------------------------------------------------- ⋯ menus

let liveMenu = null;

function closeMenu(focusBack = false) {
  if (!liveMenu) return;
  const { menu, anchor, onKey, onDown, onScroll } = liveMenu;
  liveMenu = null;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onScroll, true);
  menu.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (focusBack && anchor.isConnected) anchor.focus();
}

/** items: [{label, run, danger}] with {sep:true} for a divider. */
function openMenu(anchor, items) {
  closeMenu(false);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => (it.sep
    ? '<hr />'
    : `<button role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ''}>${esc(it.label)}</button>`)).join('');
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
  const below = r.bottom + 4;
  const top = below + menu.offsetHeight > window.innerHeight - 8
    ? Math.max(8, r.top - menu.offsetHeight - 4)
    : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const buttons = qsa('button', menu);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
      e.preventDefault();
      const at = buttons.indexOf(document.activeElement);
      const step = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  };
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(false); };
  const onScroll = () => closeMenu(false);

  liveMenu = { menu, anchor, onKey, onDown, onScroll };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);

  for (const b of buttons) {
    b.onclick = () => {
      const item = items[Number(b.dataset.i)];
      closeMenu(true);
      Promise.resolve(item.run()).catch((e) => fail(e));
    };
  }
  buttons[0]?.focus();
}

// ---------------------------------------------------------------- clipboard

/** The webview can refuse clipboard access; falling back beats a dead button. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Delegated so a command box works the same inside a card, a dialog or a message.
document.addEventListener('click', (e) => {
  const copy = e.target.closest?.('[data-copy]');
  if (copy) {
    busyWhile(copy, async () => {
      const ok = await copyText(copy.dataset.copy);
      say(ok ? 'Command copied to the clipboard.' : 'Could not reach the clipboard — select the command and copy it by hand.',
          ok ? 'ok' : 'warn');
    });
    return;
  }
  const term = e.target.closest?.('[data-term]');
  if (term) {
    busyWhile(term, async () => {
      await call('open_login_terminal', { command: term.dataset.term });
      say('Opened Terminal with the command ready to run.');
    });
  }
});

// ---------------------------------------------------------------- fragments

const loadingBlock = (what) =>
  `<div class="empty"><span class="spin"></span> ${esc(what)}</div>`;

const errorBlock = (what, message) => `
  <div class="empty">
    <b>${esc(what)} could not be read.</b>
    <span class="meta wrap">${esc(message)}</span>
    <div class="actions" style="justify-content:center"><button class="btn ghost" data-retry="1">Try again</button></div>
  </div>`;

const emptyBlock = (title, detail) =>
  `<div class="empty"><b>${esc(title)}</b><span class="meta wrap">${esc(detail)}</span></div>`;

/** A copyable command, with the two things anyone wants to do with one. */
const cmdBox = (label, command, { terminal = true } = {}) => `
  <div class="cmd">
    ${label ? `<div class="cmd-label">${esc(label)}</div>` : ''}
    <code>${esc(command)}</code>
    <div class="actions">
      <button class="btn tiny" data-copy="${esc(command)}">Copy</button>
      ${terminal ? `<button class="btn tiny ghost" data-term="${esc(command)}">Open Terminal</button>` : ''}
    </div>
  </div>`;

// ---------------------------------------------------------------- state

const PAGE = 25;

const state = {
  tab: 'accounts',
  dismissedFirstRun: introDismissed,
  status: null,
  cfg: null,
  accounts: null,
  health: null,
  healthNote: null,
  pooling: null,
  usage: null,
  backups: null,
  hist: null,
  histRows: [],
  histPaging: true,
  filters: { search: '', project: '', from: '' },
  loading: {},
  error: {},
  autoTimer: null,
};

const provider = () => state.status?.providers?.[0] ?? null;
const healthFor = (id) => (state.health?.accounts ?? []).find((h) => h.accountId === id) ?? null;

const load = {
  status: async () => {
    state.status = await call('status');
    state.cfg = state.status.settings;
    scheduleAuto();
  },
  accounts: async () => {
    const res = await call('accounts');
    state.accounts = res.accounts ?? [];
    // Health enriches a card; losing it must not blank the tab that lists them.
    try {
      state.health = await call('health');
      state.healthNote = null;
    } catch (e) {
      state.health = null;
      state.healthNote = explain(e);
    }
    // Whether history is pooled is only reported by preflight; status has no
    // such field. Unknown stays null, so the checklist says nothing rather
    // than asserting a state nobody measured.
    try {
      const pf = await call('preflight');
      state.pooling = pf.report?.providers?.[0]?.history?.state ?? null;
    } catch {
      state.pooling = null;
    }
  },
  usage: async () => { state.usage = await call('usage'); },
  backups: async () => { state.backups = await call('backups'); },
  history: async () => { await loadHistory(0); },
};

const HAVE = {
  status: () => state.status !== null,
  accounts: () => state.accounts !== null,
  usage: () => state.usage !== null,
  backups: () => state.backups !== null,
  history: () => state.hist !== null,
};

const NEEDS = {
  accounts: ['status', 'accounts'],
  editors: ['status'],
  history: ['history'],
  usage: ['usage'],
  backups: ['backups'],
  settings: ['status'],
};

async function ensure(tab, force = false) {
  const todo = (NEEDS[tab] ?? []).filter((k) => force || !HAVE[k]());
  if (!todo.length || state.loading[tab]) return;
  state.loading[tab] = true;
  state.error[tab] = null;
  render();
  for (const key of todo) {
    try {
      await load[key]();
    } catch (e) {
      // With nothing on screen the failure is the view; with stale data still
      // showing it is a message, so the user keeps what they had.
      if (HAVE[key]()) fail(e);
      else state.error[tab] = explain(e);
      break;
    }
  }
  state.loading[tab] = false;
  render();
}

async function reload(keys) {
  for (const key of keys) {
    try {
      await load[key]();
    } catch (e) {
      fail(e);
    }
  }
  render();
}

async function loadHistory(offset) {
  const page = await call('history', { ...state.filters, limit: PAGE, offset });
  const served = typeof page.offset === 'number' ? page.offset : 0;
  // A shim that predates paging ignores --offset and answers from the top.
  // Appending that page would duplicate rows, so paging is switched off instead.
  state.histPaging = served === offset;
  state.hist = page;
  const rows = page.conversations ?? [];
  state.histRows = offset === 0 || !state.histPaging ? rows : state.histRows.concat(rows);
}

// ---------------------------------------------------------------- account flows

const STATE_PILL = { draft: 'Draft', active: 'Active', idle: 'Ready', spent: 'Limit reached' };

async function loginFlow(a) {
  const command = a.loginCommand ?? a.reauth?.command;
  if (!command) {
    say(`No login command was reported for ${a.displayName}.`, 'warn');
    return;
  }
  await dialog({
    title: a.state === 'draft' ? `Log into ${a.displayName}` : `Re-authenticate ${a.displayName}`,
    body: a.reauth?.explanation ?? 'Run this in a terminal, then /login inside the session it opens.',
    html: cmdBox('Run this', command),
    hideOk: true,
    cancelLabel: 'Close',
  });
}

async function terminalFlow(a) {
  const envVar = provider()?.envVar;
  if (!envVar || !a.configDir) {
    say('Baton could not work out the environment variable for this provider.', 'warn');
    return;
  }
  // Exported in a fresh window, so everything started from that shell —
  // claude included — reads this account's directory.
  const command = `export ${envVar}=${shq(a.configDir)}`;
  await dialog({
    title: `Terminal on ${a.displayName}`,
    body: `A new Terminal window with ${envVar} pointed at ${tilde(a.configDir)}. Anything you start from it uses this account.`,
    html: cmdBox('Runs in the new window', command),
    hideOk: true,
    cancelLabel: 'Close',
  });
}

async function renameFlow(a) {
  const current = a.hasAlias ? a.displayName : '';
  const name = await promptDialog(
    `Rename ${a.accountId}`,
    'A display name for Baton only. It never changes the config directory, the account itself, or anything an editor reads — clear it to go back to the account id.',
    { placeholder: a.accountId, value: current, okLabel: 'Save', allowEmpty: true },
  );
  if (name === null) return;
  await call('set_alias', { account: a.accountId, alias: name });
  say(name ? `${a.accountId} now shows as "${name}".` : `${a.accountId} shows under its own id again.`);
  await reload(['status', 'accounts']);
}

async function revealFlow(a) {
  try {
    await call('reveal_path', { path: a.configDir });
    say(`Opened ${tilde(a.configDir)}.`);
  } catch (e) {
    if (!(e instanceof CallError) || !e.missing) throw e;
    // No reveal command in this build; `open` does the same job from a shell.
    await call('open_login_terminal', { command: `open ${shq(a.configDir)}` });
    say(`Opened ${tilde(a.configDir)} in Finder.`);
  }
}

/**
 * The shim reports a CLI refusal as a plain error string, which loses the
 * `overridable` flag. That flag also rides on the account itself, so a refusal
 * is matched back to it rather than letting Force be offered blind.
 */
async function removeCall(a, { dryRun, force, history }) {
  try {
    const r = await call('remove_account', {
      account: a.accountId,
      dryRun,
      force,
      deleteHistory: history === 'delete',
    });
    if (r && r.ok === false) {
      return { refusals: r.refusals ?? [{ message: r.error ?? 'Baton refused, without saying why.', overridable: false }] };
    }
    return { result: r };
  } catch (e) {
    const known = (a.removable?.refusals ?? []).filter((r) => e.message.includes(r.message));
    if (known.length) return { refusals: known };
    throw e;
  }
}

const showRefusals = (name, refusals) =>
  say(`Baton did not delete ${name}.`, 'warn', {
    keep: true,
    title: 'Refused',
    lines: refusals.map((r) => r.message),
  });

function planHtml(plan, history) {
  if (!plan) return '<div class="plan"><span class="spin"></span> Working out what would happen…</div>';
  const removed = plan.removed ?? [];
  const preserved = plan.preserved ?? [];
  const shown = removed.slice(0, 5);
  return `
    <div class="plan">
      <div class="name">${plural(removed.length, 'path')} deleted · ${fmtBytes(plan.bytesFreed ?? 0)} freed</div>
      <ul>
        ${shown.map((r) => `<li>${esc(tilde(r.path))}</li>`).join('')}
        ${removed.length > shown.length ? `<li>and ${removed.length - shown.length} more</li>` : ''}
        ${removed.length ? '' : '<li>nothing — there is nothing left to delete</li>'}
      </ul>
    </div>
    ${preserved.length ? `
      <div class="plan">
        <div class="name">${plural(preserved.length, 'path')} kept</div>
        <ul>${preserved.map((p) => `<li>${esc(tilde(p.path))} — ${esc(p.reason)}</li>`).join('')}</ul>
      </div>` : ''}
    ${plan.unlinkedShared?.length ? `
      <div class="plan">${plural(plan.unlinkedShared.length, 'pooled item')} detached from the shared store first.
        The store keeps its copy at ${esc(tilde(plan.sharedStore))}.</div>` : ''}
    ${plan.rebind?.length ? `
      <div class="plan">${esc(plan.rebind.map((h) => h.label).join(', '))} point here and will need another account afterwards.</div>` : ''}`;
}

const historyChoiceHtml = () => `
  <label class="choice">
    <input type="radio" name="histChoice" data-field="history" value="keep" checked />
    <span>
      <div class="name">Keep conversation history</div>
      <div class="meta wrap">History is pooled and never recorded which account created it, so deleting
        this account must not delete conversations.</div>
    </span>
  </label>
  <label class="choice">
    <input type="radio" name="histChoice" data-field="history" value="delete" />
    <span>
      <div class="name">Also delete this account's own history</div>
      <div class="meta wrap">Only what is still inside this account's directory and was never pooled.
        The shared store is never touched.</div>
    </span>
  </label>`;

async function deleteFlow(a) {
  const name = a.displayName ?? a.accountId;
  let force = false;

  const refusals = a.removable?.ok === false ? (a.removable.refusals ?? []) : [];
  if (refusals.length) {
    const hard = refusals.some((r) => !r.overridable);
    const go = await dialog({
      title: `Baton will not delete ${name}`,
      html: `<div class="plan"><ul>${refusals.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul></div>
        <p>${hard
          ? 'That one cannot be overridden. Fix it and try again.'
          : 'This can be forced, but the reason above is real — check it first.'}</p>`,
      okLabel: 'Delete anyway',
      hideOk: hard,
      cancelLabel: hard ? 'Close' : 'Cancel',
      danger: true,
    });
    if (!go) return;
    force = true;
  }

  let history = 'keep';
  let plan;
  const first = await removeCall(a, { dryRun: true, force, history });
  if (first.refusals) {
    showRefusals(name, first.refusals);
    return;
  }
  plan = first.result;

  const answer = await dialog({
    title: `Delete ${name}?`,
    html: `
      <div id="dlgPlan">${planHtml(plan, history)}</div>
      <div class="cmd-label">Conversation history</div>
      ${historyChoiceHtml()}
      <p>A snapshot is taken before anything is deleted, so this can be undone from the Backups tab.</p>`,
    okLabel: 'Delete account',
    danger: true,
    onOpen: ({ modal }) => {
      for (const radio of qsa('input[data-field="history"]', modal)) {
        radio.onchange = async () => {
          if (!radio.checked) return;
          history = radio.value;
          const slot = qs('#dlgPlan', modal);
          slot.innerHTML = planHtml(null);
          try {
            const again = await removeCall(a, { dryRun: true, force, history });
            slot.innerHTML = again.refusals
              ? `<div class="plan">${esc(again.refusals.map((r) => r.message).join(' '))}</div>`
              : planHtml(again.result, history);
          } catch (e) {
            slot.innerHTML = `<div class="plan">${esc(explain(e))}</div>`;
          }
        };
      }
    },
  });
  if (!answer) return;
  history = answer.history ?? history;

  const working = say(`Deleting ${name}…`, 'info', { keep: true });
  let out;
  try {
    out = await removeCall(a, { dryRun: false, force, history });
  } finally {
    dismissMsg(working);
  }
  if (out.refusals) {
    showRefusals(name, out.refusals);
    return;
  }

  const r = out.result ?? {};
  const lines = [`${plural(r.removed?.length ?? 0, 'path')} deleted, ${fmtBytes(r.bytesFreed ?? 0)} freed.`];
  if (history === 'keep') lines.push('Conversation history was left in the shared store, untouched.');
  if (r.preserved?.length) lines.push(`Kept: ${r.preserved.map((p) => tilde(p.path)).join(', ')}`);
  if (r.backupPath) lines.push(`Snapshot taken: ${tilde(r.backupPath)}`);
  if (r.directoryRemoved === false) lines.push('The directory is still there, because something had to be left behind.');
  for (const w of r.warnings ?? []) lines.push(w);
  say(`Deleted ${name}.`, 'ok', { keep: true, lines });

  await reload(['status', 'accounts']);
  state.backups = null;

  if (r.rebind?.length) {
    say(`${r.rebind.map((h) => h.label).join(', ')} still point at a directory that is gone.`, 'warn', {
      title: 'Editors need a new account',
      keep: true,
      actions: [{ label: 'Re-point them…', run: (m) => repointFlow(r.rebind, m) }],
    });
  }
}

async function repointFlow(hosts, msg) {
  const pickable = (state.accounts ?? []).filter((a) => a.state !== 'draft');
  if (!pickable.length) {
    say('There is no logged-in account left to point them at. Add one first.', 'warn');
    return;
  }
  const answer = await dialog({
    title: 'Re-point editors',
    body: `${hosts.map((h) => h.label).join(', ')} will be switched to the account you pick. Reload each window afterwards.`,
    okLabel: 'Switch',
    html: `<select class="wide" data-field="account">${pickable.map((a) =>
      `<option value="${esc(a.accountId)}">${esc(a.displayName)} — ${esc(a.displayEmail)}</option>`).join('')}</select>`,
  });
  if (!answer?.account) return;
  for (const h of hosts) await call('switch_account', { account: answer.account, host: h.id });
  if (msg) dismissMsg(msg.id);
  say(`${hosts.map((h) => h.label).join(', ')} now use ${answer.account}. Reload those windows.`, 'ok', { keep: true });
  await reload(['status', 'accounts']);
}

const accountMenu = (a) => [
  { label: a.state === 'draft' ? 'Log in…' : 'Re-authenticate…', run: () => loginFlow(a) },
  { label: 'Open terminal on this account', run: () => terminalFlow(a) },
  { label: 'Rename…', run: () => renameFlow(a) },
  { label: 'Reveal config folder', run: () => revealFlow(a) },
  { sep: true },
  { label: 'Delete…', danger: true, run: () => deleteFlow(a) },
];

// ---------------------------------------------------------------- accounts view

function gate(tab, ready, what) {
  if (ready) return null;
  if (state.error[tab]) return errorBlock(what, state.error[tab]);
  return loadingBlock(`Reading ${what.toLowerCase()}…`);
}

const STATUS_LABEL = { ok: 'Looks fine', spent: 'Limit hit', draft: 'Never signed in', unknown: 'Not certain' };

const REASON_LABEL = {
  unavailable: 'Not available locally',
  unsupported: 'Not supported on this machine',
  'not-recorded': 'Not recorded yet',
  'not-applicable': 'Does not apply right now',
};

/**
 * A Field<T> from the CLI: a value with its provenance, or a reason it is
 * missing. A blank cell would read as a bug, so the reason is always shown.
 */
function fieldRow(label, f, fmt) {
  if (!f) {
    return `<div class="fx unk"><span class="k">${esc(label)}</span>
      <span class="v">Not reported</span>
      <span class="s">This build of Baton did not return the field.</span></div>`;
  }
  if (f.known) {
    return `<div class="fx"><span class="k">${esc(label)}</span>
      <span class="v">${esc(fmt(f.value))}</span>
      <span class="s">from ${esc(f.source)}</span></div>`;
  }
  return `<div class="fx unk"><span class="k">${esc(label)}</span>
    <span class="v">${esc(REASON_LABEL[f.reason] ?? 'Not known')}</span>
    <span class="s">${esc(f.detail)}</span></div>`;
}

function healthBlock(a, h) {
  if (!h) {
    return state.healthNote
      ? `<details class="hx"><summary>Health</summary><div class="hint tiny">${esc(state.healthNote)}</div></details>`
      : '';
  }
  const rows = [
    `<div class="fx"><span class="k">Status</span>
      <span class="v">${esc(STATUS_LABEL[h.status] ?? h.status)}</span>
      <span class="s">${esc(h.reason)}</span></div>`,
    fieldRow('Live sessions', h.liveSessions, (v) =>
      (v.count ? `${plural(v.count, 'session')} in ${v.editors.join(', ') || 'an unnamed editor'}` : 'None running')),
    fieldRow('Last used', h.lastUsedAt, (v) => `${relTime(v)} · ${fmtStamp(v)}`),
    fieldRow('Limit', h.spent, (v) => v.message),
  ];
  if (h.spent?.known) rows.push(fieldRow('Resets', h.spent.value.resets, (v) => v));
  rows.push(`<div class="fx"><span class="k">Editors</span>
    <span class="v">${h.boundEditors?.length ? esc(h.boundEditors.join(', ')) : 'None'}</span></div>`);
  rows.push(`<div class="fx"><span class="k">Directory</span>
    <span class="v">${esc(tilde(h.configDir ?? a.configDir))}</span></div>`);
  if (h.unattributedLimits > 0) {
    rows.push(`<div class="fx unk"><span class="k">Caveat</span>
      <span class="v">${plural(h.unattributedLimits, 'limit')} could not be tied to any account</span>
      <span class="s">The history it came from predates session recording, so "no limit here" is not
      the same as "this account is fine".</span></div>`);
  }
  return `<details class="hx"><summary>Health</summary>${rows.join('')}</details>`;
}

function accountCard(a) {
  const tags = [];
  if (a.isDefault) {
    tags.push('<span class="tag grey" title="The directory Claude Code falls back to when the environment variable is unset">terminal fallback</span>');
  }
  for (const host of a.boundHosts ?? []) tags.push(`<span class="tag">${esc(host.label)}</span>`);
  const live = a.liveSessions?.length ?? 0;
  if (live) tags.push(`<span class="tag accent">${plural(live, 'live session')}</span>`);
  if (a.hasAlias) tags.push(`<span class="tag grey">id: ${esc(a.accountId)}</span>`);
  const resets = a.state === 'spent' ? a.limit?.resets : null;

  return `
    <article class="card ${esc(a.state)}">
      <div class="card-top">
        <div class="grow">
          <div class="name">${esc(a.displayName ?? a.accountId)}
            <span class="pill ${esc(a.state)}">${esc(STATE_PILL[a.state] ?? a.state)}</span>
            ${resets ? `<span class="tag warn">resets ${esc(resets)}</span>` : ''}
          </div>
          <div class="meta">${esc(a.displayEmail ?? '')}</div>
        </div>
        <button class="icon" data-menu="${esc(a.accountId)}" aria-haspopup="menu" aria-expanded="false"
          title="Actions" aria-label="Actions for ${esc(a.displayName ?? a.accountId)}">&#8943;</button>
      </div>
      <div class="why">${esc(a.reason)}</div>
      ${a.loginCommand
        ? `${cmdBox('Log in with', a.loginCommand)}
           ${a.reauth?.explanation ? `<div class="hint tiny">${esc(a.reauth.explanation)}</div>` : ''}`
        : `<div class="next">${esc(a.nextAction)}</div>`}
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      ${healthBlock(a, healthFor(a.accountId))}
    </article>`;
}

function unavailableSection() {
  const list = state.health?.unavailable ?? [];
  if (!list.length) return '';
  return `
    <h2>Not knowable on this machine</h2>
    ${list.map((f) => `
      <div class="row"><div class="grow">
        <div class="name">${esc(f.label)}</div>
        <div class="meta wrap">${esc(f.why)}</div>
      </div></div>`).join('')}`;
}

/**
 * What a new install still needs, as an ordered checklist.
 *
 * The CLI has a guided setup; someone who only ever opens the app never sees
 * it, and pooling in particular is invisible until it has already happened.
 * This says what the remaining steps are and stops appearing once they are done.
 */
function firstRunSteps() {
  const list = state.accounts ?? [];
  const provider = state.status?.providers?.[0];
  const hosts = provider?.hosts ?? [];
  const loggedIn = list.filter((a) => a.state !== 'draft');
  const poolable = list.filter((a) => (a.boundHosts ?? []).length || a.state !== 'draft');

  const steps = [];
  if (loggedIn.length < 2) {
    steps.push({
      done: false,
      title: 'Add a second account',
      detail: 'Switching needs somewhere to switch to. Baton creates the directory; the login happens in Claude Code.',
    });
  }
  if (list.some((a) => a.state === 'draft')) {
    steps.push({
      done: false,
      title: 'Finish logging in',
      detail: 'An account with no login is a dead end — an editor can point at it but cannot use it. Each card shows its own command.',
    });
  }
  if (state.pooling && state.pooling !== 'pooled' && poolable.length) {
    steps.push({
      done: false,
      title: 'Pool your history',
      detail: 'One shared store every account reads, so switching never costs you a conversation. Backed up first, and reversible.',
    });
  }
  if (hosts.length && !hosts.some((h) => h.accountId)) {
    steps.push({
      done: false,
      title: 'Point an editor at an account',
      detail: 'On the Editors tab. Terminal-only works too — see baton init in the README.',
    });
  }
  return steps;
}

function viewFirstRun() {
  if (state.dismissedFirstRun) return '';
  const steps = firstRunSteps();
  if (!steps.length) return '';

  return `
    <div class="firstrun">
      <div class="firstrun-head">
        <strong>Getting set up</strong>
        <button class="linkbtn" id="skipIntro" type="button">Dismiss</button>
      </div>
      <ol class="firstrun-steps">
        ${steps.map((s) => `<li><span class="fr-title">${esc(s.title)}</span>
          <span class="fr-detail">${esc(s.detail)}</span></li>`).join('')}
      </ol>
    </div>`;
}

function viewAccounts() {
  const blocked = gate('accounts', HAVE.accounts() && HAVE.status(), 'Accounts');
  if (blocked) return blocked;

  const list = state.accounts ?? [];
  const drafts = list.filter((a) => a.state === 'draft').length;
  const cards = list.length
    ? list.map(accountCard).join('')
    : emptyBlock('No accounts yet',
        'Add account… creates the config directory. Logging in happens in Claude Code itself, so no credential passes through Baton.');

  return `
    ${viewFirstRun()}
    <h2>Accounts <span class="count">${list.length}${drafts ? ` · ${drafts} waiting on a login` : ''}</span></h2>
    ${cards}
    <div class="actions">
      <button class="btn" id="add">Add account…</button>
      <button class="btn ghost" id="pool">Pool history…</button>
      <button class="btn ghost" id="check">Check for problems</button>
    </div>
    ${unavailableSection()}
    <div class="hint">
      <strong>terminal fallback</strong> is the directory <code>claude</code> uses in a plain terminal
      when no editor has set <code>${esc(provider()?.envVar ?? '')}</code>. A real account, just not tied
      to an editor.
    </div>`;
}

async function addFlow() {
  const name = await promptDialog(
    'Add an account',
    'Baton creates the config directory. Logging in happens in Claude Code itself, so no credential passes through Baton.',
    { placeholder: 'work', okLabel: 'Create' },
  );
  if (!name) return;
  const res = await call('add_account', { name });
  await reload(['status', 'accounts']);
  await dialog({
    title: `Created ${res.account ?? name}`,
    body: `${tilde(res.configDir ?? '')} exists now. It stays a Draft until something logs in there.`,
    html: res.loginCommand ? cmdBox('Log in with', res.loginCommand) : '',
    hideOk: true,
    cancelLabel: 'Close',
  });
}

async function poolFlow() {
  const preview = await call('preview_link');
  const lossy = preview.lossy ?? 0;
  const ok = await confirmDialog(
    'Pool conversation history',
    `Move all history into one shared store, so every account reads and writes the same conversations.\n\n${
      lossy > 0
        ? `${plural(lossy, 'file')} cannot be combined — the store's copy wins and the other is kept as a backup.`
        : 'Nothing will be lost — everything either merges or is already identical.'
    }\n\nEverything is snapshotted first, so this is reversible from the Backups tab.`,
    { okLabel: 'Pool history' },
  );
  if (!ok) return;
  await call('apply_link');
  say('History pooled. Every account now reads and writes the same conversations.', 'ok', { keep: true });
  state.backups = null;
  state.hist = null;
  await reload(['status', 'accounts']);
}

async function checkFlow() {
  const res = await call('doctor');
  const issues = res.issues ?? [];
  if (res.healthy || !issues.length) {
    say('No problems found.');
    return;
  }
  const fixes = issues.filter((i) => i.fix).map((i) => i.fix);
  say(`${plural(issues.length, 'problem')} found.`, issues.some((i) => i.level === 'error') ? 'err' : 'warn', {
    keep: true,
    title: 'Check for problems',
    lines: issues.map((i) => (i.fix ? `${i.message}  →  ${i.fix}` : i.message)),
    actions: fixes.length
      ? [{
          label: fixes.length === 1 ? 'Copy the fix' : 'Copy all fixes',
          run: async () => {
            const done = await copyText(fixes.join('\n'));
            say(done ? 'Copied.' : 'Could not reach the clipboard.', done ? 'ok' : 'warn');
          },
        }]
      : [],
  });
}

function wireAccounts() {
  const skip = $('skipIntro');
  if (skip) {
    skip.onclick = () => {
      state.dismissedFirstRun = true;
      try { localStorage.setItem('baton.introDismissed', '1'); } catch { /* private window */ }
      render();
    };
  }
  for (const b of qsa('[data-menu]')) {
    b.onclick = () => {
      if (liveMenu?.anchor === b) {
        closeMenu(true);
        return;
      }
      const a = (state.accounts ?? []).find((x) => x.accountId === b.dataset.menu);
      if (a) openMenu(b, accountMenu(a));
    };
  }
  const add = $('add');
  if (add) add.onclick = () => busyWhile(add, addFlow);
  const pool = $('pool');
  if (pool) pool.onclick = () => busyWhile(pool, poolFlow);
  const check = $('check');
  if (check) check.onclick = () => busyWhile(check, checkFlow);
}

// ---------------------------------------------------------------- editors view

const liveIn = (hostId) => (state.accounts ?? [])
  .reduce((n, a) => n + (a.liveSessions ?? []).filter((s) => s.editorHint === hostId).length, 0);

function viewEditors() {
  const blocked = gate('editors', HAVE.status(), 'Editors');
  if (blocked) return blocked;
  const p = provider();
  const reloadHint = `<div class="hint">Changing this rewrites that editor's <code>settings.json</code>.
    Reload the editor window afterwards, then <code>claude --resume</code>.</div>`;

  if (!p.hosts.length) {
    return `<h2>Editors</h2>${emptyBlock('No supported editors found',
      'Baton looks for editors that keep a settings.json it can point at an account. Nothing here means none were installed where it looked.')}${reloadHint}`;
  }

  const label = (id) => {
    const a = p.accounts.find((x) => x.id === id);
    return a ? `${a.displayName} — ${a.displayEmail}` : id;
  };

  const rows = p.hosts.map((h) => {
    const live = liveIn(h.id);
    return `
      <div class="row">
        <div class="grow">
          <div class="name">${esc(h.label)}
            ${h.inconsistent ? '<span class="tag warn" title="This editor names one directory for the extension and a different one for its terminal">inconsistent</span>' : ''}
            ${live ? `<span class="tag accent">${plural(live, 'session')} live</span>` : ''}
          </div>
          <div class="meta">${esc(h.accountId ? label(h.accountId) : 'not set — uses the terminal fallback')}</div>
        </div>
        <select data-host="${esc(h.id)}" data-current="${esc(h.accountId ?? '')}"
                aria-label="Account for ${esc(h.label)}">
          ${h.accountId ? '' : '<option value="" selected>Not set</option>'}
          ${p.accounts.map((a) =>
            `<option value="${esc(a.id)}"${a.id === h.accountId ? ' selected' : ''}>${esc(a.displayName)}</option>`).join('')}
        </select>
      </div>`;
  }).join('');

  return `
    <h2>Which account each editor uses</h2>
    ${rows}
    <div class="actions">
      <select id="allPick" aria-label="Account for every editor">
        ${p.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.displayName)}</option>`).join('')}
      </select>
      <button class="btn" id="applyAll">Use for every editor</button>
    </div>
    ${reloadHint}`;
}

function wireEditors() {
  for (const sel of qsa('select[data-host]')) {
    sel.onchange = async () => {
      const host = sel.dataset.host;
      const was = sel.dataset.current;
      const account = sel.value;
      if (!account) return;
      sel.disabled = true;
      try {
        const ok = await confirmDialog(
          `Switch ${host} to ${account}?`,
          `This rewrites ${host}'s settings.json, changing which account it logs in as.\n\nReload that editor's window afterwards. Conversation history is shared, so nothing is lost.`,
          { okLabel: 'Switch' },
        );
        if (!ok) {
          sel.value = was;
          return;
        }
        await call('switch_account', { account, host });
        say(`${host} now uses ${account}. Reload that editor's window.`, 'ok', { keep: true });
        await reload(['status', 'accounts']);
      } catch (e) {
        sel.value = was;
        fail(e);
      } finally {
        if (sel.isConnected) sel.disabled = false;
      }
    };
  }

  const all = $('applyAll');
  if (all) {
    all.onclick = () => busyWhile(all, async () => {
      const account = $('allPick').value;
      const ok = await confirmDialog(
        `Switch every editor to ${account}?`,
        `This rewrites settings.json for all ${plural(provider().hosts.length, 'editor')}. You will need to reload each window.`,
        { okLabel: 'Switch all' },
      );
      if (!ok) return;
      await call('switch_account', { account, host: null });
      say(`Every editor now uses ${account}. Reload their windows.`, 'ok', { keep: true });
      await reload(['status', 'accounts']);
    });
  }
}

// ---------------------------------------------------------------- history view

function viewHistory() {
  const blocked = gate('history', HAVE.history(), 'History');
  if (blocked) return blocked;

  const h = state.hist;
  const facets = h.facets ?? { projects: [], launchedFrom: [] };
  const opt = (list, selected, allLabel) =>
    [`<option value="">${esc(allLabel)}</option>`].concat((list ?? []).map((f) =>
      `<option value="${esc(f.value)}"${f.value === selected ? ' selected' : ''}>${esc(f.value)} (${f.count})</option>`)).join('');

  const rows = state.histRows.map((c) => {
    const size = fmtBytes(c.sizeBytes);
    // messages is null when the transcript was too big to count. Say that,
    // rather than printing "null msgs" as the first version did.
    const volume = typeof c.messages === 'number' ? `${plural(c.messages, 'msg')} · ${size}` : `${size} · too large to count`;
    return `
      <div class="row tight">
        <div class="grow">
          <div class="clamp">${esc(c.displayTitle ?? c.title ?? 'Untitled')}</div>
          <div class="meta">${esc(c.displayProject ?? c.project ?? '—')} · ${esc(volume)} · ${esc(relTime(c.updatedAt))}</div>
        </div>
      </div>`;
  }).join('');

  const more = h.hasMore
    ? (state.histPaging
        ? '<div class="actions"><button class="btn ghost" id="more">Load more</button></div>'
        : `<div class="hint">Showing the first ${state.histRows.length}. This build of the app cannot ask
             for the next page yet — <code>baton history --offset ${state.histRows.length}</code> can.</div>`)
    : '';

  const filtered = h.total !== h.totalUnfiltered;

  return `
    <div class="filters">
      <select id="fProject" aria-label="Project">${opt(facets.projects, state.filters.project, 'All projects')}</select>
      <select id="fFrom" aria-label="Launched from">${opt(facets.launchedFrom, state.filters.from, 'Anywhere')}</select>
    </div>
    <input type="search" id="fSearch" class="wide" placeholder="Search titles and projects…"
           value="${esc(state.filters.search)}" aria-label="Search conversations" />
    <h2>Conversations
      <span class="count">${state.histRows.length} of ${h.total}${filtered ? ` matched, from ${h.totalUnfiltered}` : ''}</span>
    </h2>
    ${state.loading.history ? loadingBlock('Reading conversations…') : ''}
    ${rows || (state.loading.history ? '' : emptyBlock('Nothing matched', 'Clear the filters or search for something else.'))}
    ${more}
    <div class="hint">Read from the shared store, so this is the same list whichever account is active.
      <strong>Anywhere</strong> filters how a session was launched — a transcript records the integration
      (<code>claude-vscode</code>), not which fork of VS Code.</div>`;
}

function wireHistory() {
  const refetch = async (offset = 0) => {
    state.loading.history = true;
    render();
    try {
      await loadHistory(offset);
    } catch (e) {
      fail(e);
    } finally {
      state.loading.history = false;
      render();
    }
  };

  const project = $('fProject');
  if (project) project.onchange = () => { state.filters.project = project.value; refetch(0); };
  const from = $('fFrom');
  if (from) from.onchange = () => { state.filters.from = from.value; refetch(0); };

  const more = $('more');
  if (more) {
    more.onclick = () => busyWhile(more, async () => {
      await loadHistory(state.histRows.length);
      render();
    });
  }

  const search = $('fSearch');
  if (search) {
    let timer;
    search.oninput = () => {
      state.filters.search = search.value;
      clearTimeout(timer);
      timer = setTimeout(() => refetch(0), 250);
    };
    // Re-rendering replaces the field, so put the caret back where it was.
    if (document.activeElement !== search && state.filters.search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }
}

// ---------------------------------------------------------------- usage view

function viewUsage() {
  const blocked = gate('usage', HAVE.usage(), 'Usage');
  if (blocked) return blocked;

  const u = state.usage;
  const models = u.models ?? [];
  const tokenStats = (m) => `
    <div class="stats">
      <span><b>${esc(fmtNum(m.turns))}</b> turns</span>
      <span>in <b>${esc(fmtNum(m.input))}</b></span>
      <span>out <b>${esc(fmtNum(m.output))}</b></span>
      <span>cache write <b>${esc(fmtNum(m.cacheWrite))}</b></span>
      <span>cache read <b>${esc(fmtNum(m.cacheRead))}</b></span>
    </div>`;

  const rows = models.map((m) => {
    const cost = fmtUsd(m.costUsd);
    return `
      <div class="row col">
        <div class="bar">
          <div class="grow name">${esc(m.model)}</div>
          ${cost
            ? `<div class="big">${esc(cost)}</div>`
            : '<div class="unpriced" title="No published rate for this model, so Baton shows nothing rather than a wrong number">unpriced</div>'}
        </div>
        ${tokenStats(m)}
      </div>`;
  }).join('');

  const span = u.firstAt && u.lastAt
    ? `${fmtStamp(u.firstAt)} to ${fmtStamp(u.lastAt)}`
    : 'an unrecorded window';

  return `
    <h2>API-equivalent cost</h2>
    <div class="row col total">
      <div class="bar">
        <div class="grow name">Everything on this machine</div>
        <div class="big">${esc(fmtUsd(u.totals?.costUsd) ?? '—')}</div>
      </div>
      ${tokenStats(u.totals ?? {})}
    </div>
    <div class="hint">What this work would have cost at published API rates. A subscription is not billed
      this way — the number is a comparison, not an invoice. Counted from
      ${plural(u.conversations ?? 0, 'conversation')} spanning ${esc(span)}.</div>

    <h2>By model <span class="count">${models.length}</span></h2>
    ${rows || emptyBlock('No usage recorded yet', 'Transcripts are where the token counts come from. Once a session runs, this fills in.')}`;
}

// ---------------------------------------------------------------- backups view

const PRUNE_REASON = {
  age: 'older than the age limit',
  size: 'over the size budget',
  count: 'past the keep count',
};

function policyWords(p) {
  const parts = [`Keeping the newest ${plural(p.keepCount ?? 0, 'snapshot')}`];
  parts.push(p.maxTotalMb > 0 ? `up to ${p.maxTotalMb}MB` : 'with no size budget');
  parts.push(p.maxAgeDays > 0 ? `for ${plural(p.maxAgeDays, 'day')}` : 'with no age limit');
  if (p.maxCount > 0) parts.push(`and never more than ${p.maxCount} in all`);
  // Nothing prunes on a timer today, so this does not claim it does.
  return `${parts.join(', ')}. Anything outside that goes when you prune.`;
}

function viewBackups() {
  const blocked = gate('backups', HAVE.backups(), 'Backups');
  if (blocked) return blocked;

  const b = state.backups;
  const stats = b.stats ?? {};
  const policy = b.policy ?? {};
  const snapshots = b.snapshots ?? [];
  const where = snapshots[0]?.dir
    ? tilde(snapshots[0].dir.slice(0, snapshots[0].dir.lastIndexOf('/')))
    : tilde(`${state.status?.appHome ?? ''}/backups`);

  // wouldPrune can be above zero while the size budget is still fine — an age
  // or count limit bites on its own, and saying nothing would hide that.
  const pending = stats.overBudget || (stats.wouldPrune ?? 0) > 0
    ? `<div class="row" style="border-color:var(--warn)">
         <div class="grow">
           <div class="name">${stats.overBudget ? 'Over budget' : 'Outside the policy'}</div>
           <div class="meta wrap">${plural(stats.wouldPrune ?? 0, 'snapshot')} would go if you pruned now.</div>
         </div>
         <button class="btn tiny" id="prune">Prune now</button>
       </div>`
    : '';

  const rows = snapshots.map((s) => `
    <div class="row col">
      <div class="bar">
        <div class="grow">
          <div class="name">${esc(s.label && s.label !== 'unknown' ? s.label : 'Unlabelled snapshot')}
            ${s.degraded ? '<span class="tag warn" title="Written before manifests existed, so this was rebuilt by reading the directory">older snapshot, no manifest</span>' : ''}
          </div>
          <div class="meta">${esc(relTime(s.createdAt))} · ${esc(fmtBytes(s.bytes))} · ${plural(s.entries?.length ?? 0, 'entry', 'entries')}</div>
        </div>
        <button class="btn tiny ghost" data-restore="${esc(s.id)}">Restore…</button>
      </div>
      <div class="meta">${esc(s.id)}</div>
    </div>`).join('');

  return `
    <h2>Backups <span class="count">${plural(stats.count ?? 0, 'snapshot')} · ${esc(fmtBytes(stats.totalBytes ?? 0))}</span></h2>
    <div class="hint" style="margin-top:0">${esc(policyWords(policy))}</div>
    ${pending}
    <div class="actions">
      <button class="btn ghost" id="pruneBtn">Prune…</button>
    </div>
    <h2>Snapshots</h2>
    ${rows || emptyBlock('No snapshots yet', 'One is taken before anything destructive — a switch, a pooling, a deletion.')}
    <div class="hint">They live in <code>${esc(where)}</code>. They exist because switching accounts and
      pooling history rewrite real files: the snapshot is the undo.</div>`;
}

async function pruneFlow() {
  const dry = await call('backups_prune', { dryRun: true });
  const deleted = dry.deleted ?? [];
  if (!deleted.length) {
    say('Nothing to prune — every snapshot is inside the policy.');
    return;
  }
  const ok = await dialog({
    title: 'Prune old snapshots',
    html: `
      <div class="plan">
        <div class="name">${plural(deleted.length, 'snapshot')} deleted · ${fmtBytes(dry.bytesFreed ?? 0)} freed</div>
        <ul>${deleted.map((d) => `<li>${esc(d.label && d.label !== 'unknown' ? d.label : d.id)} —
          ${esc(fmtBytes(d.bytes))} — ${esc(PRUNE_REASON[d.reason] ?? d.reason)}</li>`).join('')}</ul>
      </div>
      <p>${plural(dry.kept ?? 0, 'snapshot')} would remain, holding ${fmtBytes(dry.bytesRemaining ?? 0)}.
      Deleting a snapshot is permanent — it is the undo for an earlier change.</p>`,
    okLabel: 'Prune now',
    danger: true,
  });
  if (!ok) return;

  const res = await call('backups_prune', { dryRun: false });
  say(`Pruned ${plural(res.deleted?.length ?? 0, 'snapshot')}, freeing ${fmtBytes(res.bytesFreed ?? 0)}.`, 'ok', {
    keep: true,
    lines: res.overBudget
      ? ['Still over the size budget: the keep-count is holding snapshots the budget would otherwise drop.']
      : [],
  });
  await reload(['backups']);
}

async function restoreFlow(id) {
  const dry = await call('backups_restore', { id, dryRun: true });
  const entries = dry.entries ?? [];
  const ok = await dialog({
    title: 'Restore this snapshot',
    html: `
      <div class="plan">
        <div class="name">${plural(dry.restored ?? 0, 'path')} written back${dry.skipped ? `, ${dry.skipped} skipped` : ''}</div>
        <ul>${entries.map((e) => `<li>${esc(e.tag)} — ${esc(e.action)}${e.reason ? `: ${esc(e.reason)}` : ''}<br />${esc(tilde(e.originalPath))}</li>`).join('')}</ul>
      </div>
      <p>Whatever is there now is snapshotted first, so this restore is itself undoable from this tab.
      Reload any editor window afterwards.</p>`,
    okLabel: 'Restore',
    danger: true,
  });
  if (!ok) return;

  const res = await call('backups_restore', { id, dryRun: false });
  const lines = [];
  if (res.skipped) lines.push(`${plural(res.skipped, 'path')} skipped: ${(res.entries ?? []).filter((e) => e.action === 'skipped').map((e) => e.reason ?? e.tag).join('; ')}`);
  if (res.undoSnapshotId) lines.push(`Undo snapshot: ${res.undoSnapshotId}`);
  say(`Restored ${plural(res.restored ?? 0, 'path')} from ${id}.`, 'ok', { keep: true, lines });
  await reload(['backups', 'status', 'accounts']);
}

function wireBackups() {
  for (const id of ['prune', 'pruneBtn']) {
    const b = $(id);
    if (b) b.onclick = () => busyWhile(b, pruneFlow);
  }
  for (const b of qsa('[data-restore]')) {
    b.onclick = () => busyWhile(b, () => restoreFlow(b.dataset.restore));
  }
}

// ---------------------------------------------------------------- settings view

function viewSettings() {
  const blocked = gate('settings', HAVE.status(), 'Settings');
  if (blocked) return blocked;

  const c = state.cfg;
  const a = c.autoSwitch;
  const off = a.enabled ? '' : 'disabled';
  const b = c.backups ?? {};
  const d = c.display ?? {};

  const number = (key, label, meta, value) => `
    <div class="row">
      <div class="grow"><div class="name">${esc(label)}</div><div class="meta wrap">${esc(meta)}</div></div>
      <input type="number" min="0" step="1" data-set="${esc(key)}" data-was="${esc(value)}"
             data-label="${esc(label)}" value="${esc(value)}" aria-label="${esc(label)}" />
    </div>`;

  const toggle = (id, label, meta, checked) => `
    <div class="row">
      <label class="toggle grow">
        <input type="checkbox" id="${esc(id)}" ${checked ? 'checked' : ''} />
        <span><div class="name">${esc(label)}</div><div class="meta wrap">${esc(meta)}</div></span>
      </label>
    </div>`;

  return `
    <h2>Auto-switch</h2>
    ${toggle('autoEnabled', 'Watch for a spent account',
      'Polls the shared history for the provider saying the session limit is hit.', a.enabled)}
    <div class="row">
      <div class="grow">
        <div class="name">When one runs out</div>
        <div class="meta wrap">${a.mode === 'switch'
          ? 'Point every editor at the next account automatically'
          : 'Show a message here and leave editors alone'}</div>
      </div>
      <select id="autoMode" ${off} aria-label="What to do when an account runs out">
        <option value="notify"${a.mode === 'notify' ? ' selected' : ''}>Just tell me</option>
        <option value="switch"${a.mode === 'switch' ? ' selected' : ''}>Switch for me</option>
      </select>
    </div>
    <div class="row">
      <div class="grow"><div class="name">Check every</div>
        <div class="meta wrap">How often to look for a limit message</div></div>
      <select id="autoPoll" ${off} aria-label="How often to check">
        ${[30, 60, 120, 300].map((n) =>
          `<option value="${n}"${a.pollSeconds === n ? ' selected' : ''}>${n}s</option>`).join('')}
      </select>
    </div>
    <div class="actions"><button class="btn ghost" id="checkNow">Check now</button></div>

    <h2>Backups</h2>
    ${number('backups.keepCount', 'Keep the newest',
      'Snapshots always kept, whatever the size or age limits say.', b.keepCount ?? 0)}
    ${number('backups.maxCount', 'Never keep more than',
      'A hard ceiling on how many snapshots exist at all. 0 means no ceiling.', b.maxCount ?? 0)}
    ${number('backups.maxTotalMb', 'Size budget (MB)',
      'Oldest go first once the tree is bigger than this. 0 means no size limit.', b.maxTotalMb ?? 0)}
    ${number('backups.maxAgeDays', 'Maximum age (days)',
      'Older snapshots are dropped when you prune. 0 means no age limit.', b.maxAgeDays ?? 0)}
    <div class="hint" style="margin-top:2px">These are the limits the Backups tab prunes against.</div>

    <h2>Privacy</h2>
    ${toggle('hideEmails', 'Mask account emails',
      'Shows n•••@•••.com instead of the address, for screen sharing and screenshots.', !!d.hideEmails)}
    ${toggle('hideProjects', 'Mask project names',
      'Replaces project names with Project A, B, … and shortens paths, here and in the CLI.', !!d.hideProjects)}

    <h2>General</h2>
    ${toggle('reloadHint', 'Show the reload reminder',
      'Remind you to reload the editor window after switching.', !!c.showReloadHint)}

    <div class="hint">Stored in <code>${esc(tilde(state.status?.settingsPath ?? ''))}</code>.
      The CLI reads the same file (<code>baton settings</code>).</div>`;
}

async function setSetting(key, value) {
  await call('set_setting', { key, value: String(value) });
  state.cfg = (await call('settings')).settings;
  scheduleAuto();
  render();
}

function wireSettings() {
  const bind = (id, key, read) => {
    const elm = $(id);
    if (!elm) return;
    elm.onchange = async () => {
      elm.disabled = true;
      try {
        await setSetting(key, read(elm));
      } catch (e) {
        fail(e);
        render();
      } finally {
        if (elm.isConnected) elm.disabled = false;
      }
    };
  };

  bind('autoEnabled', 'autoSwitch.enabled', (e) => e.checked);
  bind('autoMode', 'autoSwitch.mode', (e) => e.value);
  bind('autoPoll', 'autoSwitch.pollSeconds', (e) => e.value);
  bind('hideEmails', 'display.hideEmails', (e) => e.checked);
  bind('hideProjects', 'display.hideProjects', (e) => e.checked);
  bind('reloadHint', 'showReloadHint', (e) => e.checked);

  for (const input of qsa('input[data-set]')) {
    input.onchange = async () => {
      const n = Number(input.value.trim());
      if (!Number.isInteger(n) || n < 0) {
        say(`${input.dataset.label} has to be a whole number, zero or more.`, 'warn');
        input.value = input.dataset.was;
        return;
      }
      input.disabled = true;
      try {
        await setSetting(input.dataset.set, n);
        state.backups = null;
        say('Saved.');
      } catch (e) {
        fail(e);
        input.value = input.dataset.was;
      } finally {
        if (input.isConnected) input.disabled = false;
      }
    };
  }

  const now = $('checkNow');
  if (now) now.onclick = () => busyWhile(now, () => runAutoswitch(true));
}

// ---------------------------------------------------------------- autoswitch

async function runAutoswitch(manual = false) {
  const res = await call('autoswitch');
  if (!res.spent) {
    if (manual) say('No account has hit its limit recently.');
    return;
  }
  const active = (res.activeAccounts ?? []).join(', ');
  if (res.acted) {
    say(`Limit reached. Switched ${(res.switched ?? []).join(', ')} to ${res.candidate}. Reload those windows.`,
        'warn', { keep: true, global: true, key: `switched:${res.candidate}` });
    await reload(['status', 'accounts']);
  } else if (!res.candidate) {
    say(`Limit reached on ${active} — there is no spare account to switch to.`, 'err',
        { keep: true, global: true, key: `nospare:${active}` });
  } else {
    say(`Limit reached on ${active}. Switch to "${res.candidate}" from the Editors tab.`, 'warn',
        { keep: true, global: true, key: `spent:${active}:${res.candidate}` });
  }
}

function scheduleAuto() {
  clearInterval(state.autoTimer);
  if (!state.cfg?.autoSwitch?.enabled) return;
  state.autoTimer = setInterval(
    () => runAutoswitch().catch(() => { /* a background poll must not shout */ }),
    Math.max(30, Number(state.cfg.autoSwitch.pollSeconds) || 60) * 1000,
  );
}

// ---------------------------------------------------------------- shell

const VIEWS = {
  accounts: [viewAccounts, wireAccounts],
  editors: [viewEditors, wireEditors],
  history: [viewHistory, wireHistory],
  usage: [viewUsage, null],
  backups: [viewBackups, wireBackups],
  settings: [viewSettings, wireSettings],
};

function subtitle() {
  const p = provider();
  if (!p) return state.error[state.tab] ? 'Could not read state' : 'Reading state…';
  const bound = p.hosts.filter((h) => h.accountId).length;
  const bits = [p.label, plural(p.accounts.length, 'account'), `${bound}/${p.hosts.length} editors bound`];
  const drafts = (state.accounts ?? []).filter((a) => a.state === 'draft').length;
  if (drafts) bits.push(`${drafts} need${drafts === 1 ? 's' : ''} a login`);
  return bits.join(' · ');
}

let lastRendered = null;

function render() {
  // The ⋯ menu is anchored to a card this is about to replace, so leaving it
  // open would strand it over the new layout with focus nowhere.
  closeMenu(false);
  $('sub').textContent = subtitle();
  for (const b of qsa('nav button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  }
  const main = $('main');
  const keep = lastRendered === state.tab ? main.scrollTop : 0;
  const [view, wire] = VIEWS[state.tab] ?? VIEWS.accounts;
  main.innerHTML = view();
  const retry = qs('[data-retry]', main);
  if (retry) retry.onclick = () => busyWhile(retry, () => ensure(state.tab, true));
  wire?.();
  main.scrollTop = keep;
  lastRendered = state.tab;
  renderMsgs();
}

function goTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  closeMenu(false);
  dropOtherTabMessages();
  render();
  ensure(tab);
}

const tabs = qsa('nav button');
for (const b of tabs) {
  b.onclick = () => goTab(b.dataset.tab);
}
document.querySelector('nav').onkeydown = (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  goTab(next.dataset.tab);
};

$('reload').onclick = () => busyWhile($('reload'), async () => {
  state.status = null;
  state.accounts = null;
  state.usage = null;
  state.backups = null;
  state.hist = null;
  await ensure(state.tab, true);
});

// Escape is the way out of anything: a dialog, a menu, and — when neither is
// open — the message that has been sitting there since the user last asked a
// question they have finished with.
document.addEventListener('keydown', (e) => {
  // A dialog and a menu both close on Escape from a capture handler that calls
  // preventDefault. Without this the same keypress would close one of those and
  // silently swallow a message the user had not finished reading.
  if (e.defaultPrevented) return;
  if (e.key !== 'Escape' || liveMenu || $('scrim').classList.contains('open')) return;
  const last = messages[messages.length - 1];
  if (last) {
    e.preventDefault();
    dismissMsg(last.id);
  }
});

listen('accounts-changed', () => { reload(['status', 'accounts']).catch(() => {}); });
listen('baton-error', (e) => say(errorText(e.payload), 'err', { keep: true, global: true }));

render();
ensure('accounts');
