const $ = (id) => document.getElementById(id);

if (!window.__TAURI__?.core?.invoke) {
  $('sub').textContent = 'Tauri API unavailable';
  $('msg').className = 'err';
  $('msg').textContent = 'This page must run inside the Baton app.';
  throw new Error('no tauri');
}
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- dialogs
// Tauri's webview implements neither confirm() nor prompt(); they return
// undefined silently, which is why the first version's buttons did nothing.

function dialog(render) {
  return new Promise((resolve) => {
    const scrim = $('scrim');
    const close = (value) => {
      scrim.classList.remove('open');
      $('modal').innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') $('ok')?.click();
    };
    $('modal').innerHTML = render();
    scrim.classList.add('open');
    document.addEventListener('keydown', onKey);
    scrim.onclick = (e) => { if (e.target === scrim) close(null); };
    $('cancel').onclick = () => close(null);
    $('ok').onclick = () => close($('field') ? ($('field').value.trim() || null) : true);
    $('field')?.focus();
  });
}

const confirmDialog = (title, body, { danger = false, okLabel = 'Continue' } = {}) =>
  dialog(() => `
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    <div class="actions">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger' : ''}" id="ok">${esc(okLabel)}</button>
    </div>`);

const promptDialog = (title, body, placeholder = '') =>
  dialog(() => `
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    <input type="text" id="field" class="wide" placeholder="${esc(placeholder)}" />
    <div class="actions">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn" id="ok">Create</button>
    </div>`);

// ---------------------------------------------------------------- state

let data = null, cfg = null, hist = null, tab = 'accounts', busy = false;
let filters = { search: '', project: '', from: '' };
let autoTimer = null;

function say(text, kind = 'ok') {
  const el = $('msg');
  el.className = kind;
  el.textContent = text;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.className = ''; }, 5000);
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { say(String(e), 'err'); } finally { busy = false; }
}

const provider = () => data?.providers?.[0];

// ---------------------------------------------------------------- accounts

function viewAccounts() {
  const p = provider();
  const rows = p.accounts.map((a) => {
    const used = a.usedBy.length
      ? a.usedBy.map((u) => `<span class="tag">${esc(u)}</span>`).join(' ')
      : `<span class="tag grey">${a.isDefault ? 'terminal fallback' : 'unused'}</span>`;
    return `
      <div class="row">
        <div class="grow">
          <div class="name">${esc(a.id)}</div>
          <div class="meta">${esc(a.email ?? 'not logged in — run the login command')}</div>
        </div>${used}
      </div>`;
  }).join('');

  return `
    <h2>Accounts</h2>
    ${rows || '<div class="empty">No accounts found.</div>'}
    <div class="actions">
      <button class="btn" id="add">Add account…</button>
      <button class="btn ghost" id="pool">Pool history…</button>
      <button class="btn ghost" id="check">Check for problems</button>
    </div>
    <div class="hint">
      <strong>terminal fallback</strong> is <code>~/.claude</code> — what <code>claude</code> uses in a
      plain terminal when no editor has set <code>${esc(p.envVar)}</code>. A real account, just not tied
      to an editor.
    </div>`;
}

function wireAccounts() {
  $('add').onclick = () => guard(async () => {
    const name = await promptDialog(
      'Add an account',
      'Baton creates the config directory. Logging in happens in your provider’s CLI, so no credential passes through Baton.',
      'work',
    );
    if (!name) return;
    const res = await invoke('add_account', { name });
    const open = await confirmDialog(
      'Now log in',
      `Created ${res.configDir}\n\nRun this to log in:\n${res.loginCommand}\n\nOpen Terminal and run it for you?`,
      { okLabel: 'Open Terminal' },
    );
    if (open) await invoke('open_login_terminal', { command: res.loginCommand });
    say(`Created "${res.account}". Log into it, then switch tabs to refresh.`);
    await refresh();
  });

  $('pool').onclick = () => guard(async () => {
    const preview = await invoke('preview_link');
    const warn = preview.lossy > 0
      ? `${preview.lossy} file(s) cannot be combined — the first copy wins and the other is kept as a backup.`
      : 'Nothing will be lost — everything either merges or is already identical.';
    const ok = await confirmDialog(
      'Pool conversation history',
      `Move all history into one shared store, so every account reads and writes the same conversations.\n\n${warn}\n\nEverything is backed up first, and this is reversible.`,
      { okLabel: 'Pool history' },
    );
    if (!ok) return;
    await invoke('apply_link');
    say('History pooled. Every account now shares it.');
    await refresh();
  });

  $('check').onclick = () => guard(async () => {
    const res = await invoke('doctor');
    say(res.healthy ? 'No problems found.' : res.issues.map((i) => `• ${i.message}`).join('\n'),
        res.healthy ? 'ok' : 'warn');
  });
}

// ---------------------------------------------------------------- editors

function viewEditors() {
  const p = provider();
  if (!p.hosts.length) return '<div class="empty">No supported editors found.</div>';

  const rows = p.hosts.map((h) => `
    <div class="row">
      <div class="grow">
        <div class="name">${esc(h.label)}
          ${h.inconsistent ? '<span class="tag warn">inconsistent</span>' : ''}</div>
        <div class="meta">${esc(h.accountId ?? 'no account set — uses the terminal fallback')}</div>
      </div>
      <select data-host="${esc(h.id)}" data-current="${esc(h.accountId ?? '')}">
        ${p.accounts.map((a) =>
          `<option value="${esc(a.id)}"${a.id === h.accountId ? ' selected' : ''}>${esc(a.id)}</option>`
        ).join('')}
      </select>
    </div>`).join('');

  return `
    <h2>Which account each editor uses</h2>
    ${rows}
    <div class="actions">
      <select id="allPick">
        ${p.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('')}
      </select>
      <button class="btn" id="applyAll">Use for every editor</button>
    </div>
    <div class="hint">Changing this rewrites that editor's <code>settings.json</code>. After switching,
      reload the editor window, then <code>claude --resume</code>.</div>`;
}

function wireEditors() {
  for (const sel of document.querySelectorAll('select[data-host]')) {
    sel.onchange = (e) => guard(async () => {
      const host = e.target.dataset.host;
      const was = e.target.dataset.current;
      const account = e.target.value;
      const ok = await confirmDialog(
        `Switch ${host} to ${account}?`,
        `This rewrites ${host}'s settings.json, changing which account it logs in as.\n\nYou will need to reload that editor's window. Your conversation history is shared, so nothing is lost.`,
        { okLabel: 'Switch' },
      );
      if (!ok) { e.target.value = was; return; }
      await invoke('switch_account', { account, host });
      say(`${host} → ${account}. Reload that editor's window.`);
      await refresh();
    });
  }

  $('applyAll').onclick = () => guard(async () => {
    const account = $('allPick').value;
    const ok = await confirmDialog(
      `Switch every editor to ${account}?`,
      `This rewrites settings.json for all ${provider().hosts.length} editors. You will need to reload each window.`,
      { okLabel: 'Switch all' },
    );
    if (!ok) return;
    await invoke('switch_account', { account, host: null });
    say(`Every editor → ${account}. Reload their windows.`);
    await refresh();
  });
}

// ---------------------------------------------------------------- history

function viewHistory() {
  if (!hist) return '<div class="empty">Loading conversations…</div>';

  const opt = (list, selected, allLabel) =>
    [`<option value="">${allLabel}</option>`].concat(
      list.map((f) =>
        `<option value="${esc(f.value)}"${f.value === selected ? ' selected' : ''}>${esc(f.value)} (${f.count})</option>`)
    ).join('');

  const rows = hist.conversations.map((c) => {
    const when = c.updatedAt ? c.updatedAt.slice(0, 16).replace('T', ' ') : '';
    return `
      <div class="row tight">
        <div class="grow">
          <div class="clamp">${esc(c.title)}</div>
          <div class="meta">${esc(c.project)} · ${c.messages} msgs · ${esc(when)}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="filters">
      <select id="fProvider">${opt(hist.facets.providers, '', 'All providers')}</select>
      <select id="fProject">${opt(hist.facets.projects, filters.project, 'All projects')}</select>
      <select id="fFrom">${opt(hist.facets.launchedFrom, filters.from, 'Anywhere')}</select>
    </div>
    <input type="text" id="fSearch" class="wide" placeholder="Search titles and projects…"
           value="${esc(filters.search)}" />
    <h2>${hist.shown} of ${hist.total} conversations</h2>
    ${rows || '<div class="empty">Nothing matched.</div>'}
    <div class="hint">Read from the shared store, so this is the same list whichever account is
      active. <strong>Anywhere</strong> filters how a session was launched — transcripts record the
      integration (<code>claude-vscode</code>), not which fork of VS Code.</div>`;
}

function wireHistory() {
  const reload = () => guard(async () => {
    hist = await invoke('history', {
      search: filters.search, project: filters.project, from: filters.from,
    });
    render();
  });
  $('fProject').onchange = (e) => { filters.project = e.target.value; reload(); };
  $('fFrom').onchange = (e) => { filters.from = e.target.value; reload(); };

  let t;
  $('fSearch').oninput = (e) => {
    filters.search = e.target.value;
    clearTimeout(t);
    t = setTimeout(reload, 250);
  };
  if (document.activeElement !== $('fSearch') && filters.search) {
    const f = $('fSearch');
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  }
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const a = cfg.autoSwitch;
  const off = a.enabled ? '' : 'disabled';
  return `
    <h2>Auto-switch</h2>
    <div class="row">
      <label class="toggle grow">
        <input type="checkbox" id="autoEnabled" ${a.enabled ? 'checked' : ''} />
        <span>
          <div class="name">Watch for a spent account</div>
          <div class="meta">Poll for “you’ve hit your session limit” in the shared history</div>
        </span>
      </label>
    </div>
    <div class="row">
      <div class="grow">
        <div class="name">When one runs out</div>
        <div class="meta">${a.mode === 'switch'
          ? 'Point every editor at the next account automatically'
          : 'Show a message here and leave editors alone'}</div>
      </div>
      <select id="autoMode" ${off}>
        <option value="notify"${a.mode === 'notify' ? ' selected' : ''}>Just tell me</option>
        <option value="switch"${a.mode === 'switch' ? ' selected' : ''}>Switch for me</option>
      </select>
    </div>
    <div class="row">
      <div class="grow"><div class="name">Check every</div>
        <div class="meta">How often to look for a limit message</div></div>
      <select id="autoPoll" ${off}>
        ${[30, 60, 120, 300].map((n) =>
          `<option value="${n}"${a.pollSeconds === n ? ' selected' : ''}>${n}s</option>`).join('')}
      </select>
    </div>
    <div class="actions"><button class="btn ghost" id="checkNow">Check now</button></div>

    <h2>General</h2>
    <div class="row">
      <label class="toggle grow">
        <input type="checkbox" id="reloadHint" ${cfg.showReloadHint ? 'checked' : ''} />
        <span><div class="name">Show the reload reminder</div>
          <div class="meta">Remind you to reload the editor window after switching</div></span>
      </label>
    </div>
    <div class="hint">Stored in <code>${esc(data.settingsPath)}</code>. The CLI reads the same file
      (<code>baton settings</code>).</div>`;
}

function wireSettings() {
  const set = (key, value) => guard(async () => {
    await invoke('set_setting', { key, value: String(value) });
    cfg = (await invoke('settings')).settings;
    scheduleAuto();
    render();
  });
  $('autoEnabled').onchange = (e) => set('autoSwitch.enabled', e.target.checked);
  $('autoMode').onchange = (e) => set('autoSwitch.mode', e.target.value);
  $('autoPoll').onchange = (e) => set('autoSwitch.pollSeconds', e.target.value);
  $('reloadHint').onchange = (e) => set('showReloadHint', e.target.checked);
  $('checkNow').onclick = () => guard(() => runAutoswitch(true));
}

// ---------------------------------------------------------------- autoswitch

async function runAutoswitch(manual = false) {
  const res = await invoke('autoswitch');
  if (!res.spent) {
    if (manual) say('No account has hit its limit recently.');
    return;
  }
  if (res.acted) {
    say(`Limit reached. Switched ${res.switched.join(', ')} → ${res.candidate}. Reload those windows.`, 'warn');
    await refresh();
  } else if (!res.candidate) {
    say(`Limit reached on ${res.activeAccounts.join(', ')} — no spare account to switch to. Add one.`, 'err');
  } else {
    say(`Limit reached on ${res.activeAccounts.join(', ')}. Switch to "${res.candidate}" from the Editors tab.`, 'warn');
  }
}

function scheduleAuto() {
  clearInterval(autoTimer);
  if (!cfg?.autoSwitch?.enabled) return;
  autoTimer = setInterval(
    () => runAutoswitch().catch(() => {}),
    Math.max(30, cfg.autoSwitch.pollSeconds) * 1000,
  );
}

// ---------------------------------------------------------------- shell

function render() {
  const p = provider();
  if (!p) { $('main').innerHTML = '<div class="empty">No providers found.</div>'; return; }

  const bound = p.hosts.filter((h) => h.accountId).length;
  $('sub').textContent =
    `${p.label} · ${p.accounts.length} account${p.accounts.length === 1 ? '' : 's'} · ${bound}/${p.hosts.length} editors bound`;

  for (const b of document.querySelectorAll('nav button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }

  if (tab === 'accounts') { $('main').innerHTML = viewAccounts(); wireAccounts(); }
  else if (tab === 'editors') { $('main').innerHTML = viewEditors(); wireEditors(); }
  else if (tab === 'history') { $('main').innerHTML = viewHistory(); if (hist) wireHistory(); }
  else { $('main').innerHTML = viewSettings(); wireSettings(); }
}

async function refresh() {
  try {
    data = await invoke('status');
    cfg = data.settings;
    scheduleAuto();
    render();
  } catch (e) {
    say(String(e), 'err');
    $('sub').textContent = 'Could not read state';
  }
}

for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => guard(async () => {
    tab = b.dataset.tab;
    if (tab === 'history' && !hist) {
      render();
      hist = await invoke('history', filters);
    }
    render();
  });
}

listen('accounts-changed', refresh);
listen('baton-error', (e) => say(String(e.payload), 'err'));
refresh();
