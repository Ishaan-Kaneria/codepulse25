// public/js/admin.js - administrator screens: Users (CRUD + roles), Topics & Companies (CRUD), SQL Console.
// The server checks platform_administrators on every request; hiding the screens here is only for convenience.
import {
  $, $$, esc, api, fmtDate, fmtNum, table, bindRows, autoTable,
  openDrawer, closeDrawer, openModal, closeModal, toast, errorBox, icon, auth
} from './core.js';

const loading = '<div class="skeleton"></div><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:85%"></div>';
const card = (title, body, { sub = '', tools = '', flush = false } = {}) =>
  `<section class="card fade-in"><div class="card-head"><h3>${title}</h3>${sub ? `<span class="sub">${sub}</span>` : ''}<div class="tools">${tools}</div></div>
   <div class="card-body ${flush ? 'flush' : ''}">${body}</div></section>`;
function head({ title, srs = [], desc = '', actions = '' }) {
  return `<div class="page-head fade-in"><div>
      <div class="eyebrow">${srs.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
      <h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div>
    <div class="head-actions">${actions}</div></div>`;
}
const ok = (res) => toast(`<b>${esc(res.message)}</b>${res.rowCount !== undefined ? `<br><span class="small">rowCount: ${res.rowCount}${res.changes?.length ? ` · ${esc(res.changes.join(', '))}` : ''}</span>` : ''}`, 'ok');
const formError = (el, e) => {
  el.innerHTML = `<div class="note-box warn"><b>${e.status === 409 ? 'Rejected by the database.' : e.status === 400 ? 'Please fix this.' : 'Request failed.'}</b> ${esc(e.message)}
    ${e.data?.constraint ? `<div class="small" style="margin-top:6px">SQLSTATE <code>${esc(e.data.code)}</code> · constraint <code>${esc(e.data.constraint)}</code></div>` : ''}</div>`;
};

export function adminOnly(v, title) {
  if (auth.user?.is_admin) return false;
  v.innerHTML = head({ title }) + `<section class="card empty-state"><div class="lock-ic big">${icon.lock}</div><h2>Administrators only</h2>
    <p class="muted" style="max-width:56ch">Your account is not in <code>platform_administrators</code>, so this screen stays closed. The API refuses these requests too.
    Sign in as an administrator such as <b>parth_modi</b>.</p></section>`;
  return true;
}

// ================================================================ USERS
const ROLES = [
  ['solver', 'Solver', 'solvers'], ['setter', 'Problem setter', 'problem_setters'], ['manager', 'Contest manager', 'contest_managers'],
  ['moderator', 'Moderation lead', 'moderation_leads'], ['admin', 'Administrator', 'platform_administrators']
];
const roleChips = (u) => ROLES.filter(([k]) => u[k]).map(([k, l]) => `<span class="role role-${l.split(' ')[0].toLowerCase()}">${esc(l === 'Administrator' ? 'Admin' : l === 'Moderation lead' ? 'Moderator' : l === 'Problem setter' ? 'Setter' : l)}</span>`).join('') || '<span class="muted small">no role</span>';
const ustate = { q: '', page: 1 };

export async function pageUsers(v) {
  if (adminOnly(v, 'Users')) return;
  v.innerHTML = head({
    title: 'Users', srs: ['CRUD · users', 'Admin'],
    desc: 'Add, edit and delete accounts in <code>users</code>, and their rows in the five role tables. Duplicates, foreign keys and CHECKs are enforced by PostgreSQL; its error is shown here as it happens.',
    actions: `<button class="btn accent" id="u-new">${icon.plus} Add user</button>`
  }) + `<section class="card fade-in">
      <div class="filters"><div class="search">${icon.search}<input class="input" id="u-q" placeholder="Search username, email, id or country…" value="${esc(ustate.q)}"></div></div>
      <div id="u-table">${loading}</div><div class="pager" id="u-pager"></div></section>`;
  let timer;
  $('#u-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { ustate.q = e.target.value; ustate.page = 1; loadUsers(); }, 250); });
  $('#u-new').onclick = () => userForm();
  loadUsers();
}

async function loadUsers() {
  const el = $('#u-table'); if (!el) return;
  try {
    const data = await api(`/api/admin/users?${new URLSearchParams({ q: ustate.q, page: ustate.page })}`);
    el.innerHTML = table(data.rows, [
      { label: '#', num: true, render: (r) => `<span class="muted">${r.user_id}</span>` },
      { label: 'Username', render: (r) => `<span class="strong">${esc(r.username)}</span>` },
      { label: 'Email', render: (r) => `<span class="small">${esc(r.email_address)}</span>` },
      { label: 'Country', key: 'country' },
      { label: 'Roles', wrap: true, render: roleChips },
      { label: 'Registered', render: (r) => fmtDate(r.registration_date) }
    ], { onRow: true, empty: 'No users match.' });
    bindRows(el, data.rows, (r) => openUser(r.user_id));
    const pages = Math.max(1, Math.ceil(data.total / data.size));
    $('#u-pager').innerHTML = `<span>${fmtNum(data.total)} users · newest first · page ${data.page} of ${pages}</span>
      <span><button class="btn sm" id="u-prev" ${data.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <button class="btn sm" id="u-next" ${data.page >= pages ? 'disabled' : ''}>Next →</button></span>`;
    $('#u-prev').onclick = () => { ustate.page -= 1; loadUsers(); };
    $('#u-next').onclick = () => { ustate.page += 1; loadUsers(); };
  } catch (e) { el.innerHTML = errorBox(e); }
}

async function openUser(id) {
  const body = openDrawer(`User #${id}`, loading);
  try {
    const { user: u } = await api(`/api/admin/users/${id}`);
    $('#drawer-title').innerHTML = `${esc(u.username)} <span class="muted small">#${u.user_id}</span>`;
    const self = u.user_id === auth.user?.user_id;
    body.innerHTML = `
      <div class="pill-row">${roleChips(u)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="ud-edit">${icon.edit} Edit</button>
        ${self ? '<span class="chip ghost">This is you, so it cannot be deleted here</span>' : `<button class="btn danger" id="ud-del">${icon.trash} Delete</button>`}
        <a class="btn" href="#/u/${encodeURIComponent(u.username)}">${icon.arrow} Public profile</a>
      </div>
      <dl class="kv">
        <dt>user_id</dt><dd>${u.user_id}</dd><dt>username</dt><dd>${esc(u.username)}</dd>
        <dt>email_address</dt><dd>${esc(u.email_address)}</dd><dt>country</dt><dd>${esc(u.country || '—')}</dd>
        <dt>registration_date</dt><dd>${fmtDate(u.registration_date)}</dd><dt>last_login</dt><dd>${fmtDate(u.last_login_timestamp, true)}</dd>
        <dt>session_count</dt><dd>${fmtNum(u.session_count)}</dd><dt>contribution_point</dt><dd>${fmtNum(u.contribution_point)}</dd>
        ${u.admin ? `<dt>clearance_level</dt><dd>${u.clearance_level}</dd>` : ''}
      </dl>
      <div id="ud-deps">${loading}</div>`;
    $('#ud-edit').onclick = () => userForm(u);
    if ($('#ud-del')) $('#ud-del').onclick = () => confirmUserDelete(u);
    const d = await api(`/api/admin/users/${id}/dependents`);
    $('#ud-deps').innerHTML = `<h4>Rows that point at this user</h4>${depsTable(d)}`;
  } catch (e) { body.innerHTML = errorBox(e); }
}

function depsTable(d) {
  const rows = [
    ...Object.entries(d.blockers).map(([k, n]) => ({ k, n, rule: 'blocks DELETE (no delete rule)', via: d.via[k], cls: 'st-warn' })),
    ...Object.entries(d.owned).map(([k, n]) => ({ k, n, rule: 'owned content: reassign first', via: d.via[k], cls: 'st-bad' })),
    ...Object.entries(d.cascade).map(([k, n]) => ({ k, n, rule: 'ON DELETE CASCADE', via: '', cls: 'st-good' }))
  ];
  return table(rows, [
    { label: 'Table', render: (r) => `<span class="mono small">${esc(r.k)}</span>${r.via ? `<div class="small muted">${esc(r.via)}</div>` : ''}` },
    { label: 'Rows', num: true, render: (r) => fmtNum(r.n) },
    { label: 'On delete', render: (r) => `<span class="st ${r.cls}">${esc(r.rule)}</span>` }
  ], { empty: 'Nothing references this user except their own role rows.' });
}

function userForm(existing) {
  const editing = Boolean(existing);
  const u = existing || { solver: true };
  const body = openModal(editing ? `Edit user #${u.user_id}` : 'Add a user', `
    <form class="form" id="uform" novalidate autocomplete="off">
      ${editing ? '' : `<label>User ID <span class="hint">optional · blank = next free id</span><input class="input" type="number" name="user_id" min="1" placeholder="auto"></label>`}
      <label ${editing ? 'class="full"' : ''}>Username <span class="hint">3–30 letters, digits, _</span><input class="input" name="username" maxlength="30" required value="${esc(u.username || '')}" placeholder="e.g. riya_shah"></label>
      <label>Email address<input class="input" type="email" name="email_address" maxlength="100" required value="${esc(u.email_address || '')}" placeholder="riya@example.com"></label>
      <label>Country<input class="input" name="country" maxlength="50" value="${esc(u.country || '')}" placeholder="India"></label>
      <label class="full">${editing ? 'New password <span class="hint">leave blank to keep the current one</span>' : 'Password <span class="hint">at least 6 characters, stored as a bcrypt hash</span>'}
        <input class="input" type="password" name="password" autocomplete="new-password" ${editing ? '' : 'required'}></label>
      <label class="full">Roles (one row in each role table)<div class="picker">${ROLES.map(([k, l, t]) =>
        `<label title="${t}"><input type="checkbox" name="role" value="${k}" ${u[k] ? 'checked' : ''}>${esc(l)} <span class="muted small mono">${t}</span></label>`).join('')}</div></label>
      <label id="clr-wrap" ${u.admin ? '' : 'hidden'}>Clearance level <span class="hint">1 to 5 (CHECK)</span><input class="input" type="number" name="clearance_level" min="1" max="5" value="${esc(u.clearance_level ?? 1)}"></label>
      <div class="form-error full" id="uform-err"></div>
    </form>
    <div class="form-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="usave">${icon.check} ${editing ? 'Save changes' : 'Create user'}</button></div>`);
  const adminBox = $('input[value="admin"]', body);
  adminBox.addEventListener('change', () => { $('#clr-wrap', body).hidden = !adminBox.checked; });
  $('#usave', body).onclick = async () => {
    const fd = new FormData($('#uform', body));
    const picked = new Set(fd.getAll('role'));
    const payload = {
      user_id: fd.get('user_id') || '', username: fd.get('username'), email_address: fd.get('email_address'), country: fd.get('country'),
      password: fd.get('password'), roles: Object.fromEntries(ROLES.map(([k]) => [k, picked.has(k)])), clearance_level: fd.get('clearance_level')
    };
    const btn = $('#usave', body); btn.disabled = true;
    try {
      const res = editing
        ? await api(`/api/admin/users/${u.user_id}`, { method: 'PUT', body: payload })
        : await api('/api/admin/users', { method: 'POST', body: payload });
      closeModal(); ok(res);
      await loadUsers();
      openUser(editing ? u.user_id : res.user_id);
    } catch (e) { formError($('#uform-err', body), e); btn.disabled = false; }
  };
}

async function confirmUserDelete(u) {
  const body = openModal(`Delete ${esc(u.username)}?`, loading);
  let d;
  try { d = await api(`/api/admin/users/${u.user_id}/dependents`); } catch (e) { body.innerHTML = errorBox(e); return; }
  const blocked = Object.keys(d.blockers).length > 0;
  const owned = Object.keys(d.owned).length > 0;
  body.innerHTML = `
    <p>Plain delete runs <code>DELETE FROM users WHERE user_id = $1</code> for <b>${esc(u.username)}</b> (#${u.user_id}).
      Rows marked <i>ON DELETE CASCADE</i> go with it. Rows that <i>block DELETE</i> make PostgreSQL refuse it.</p>
    ${depsTable(d)}
    ${blocked && !owned ? `<div class="note-box" style="margin-top:12px"><b>Delete everything</b> removes the blocking rows first (reviews, reports, comments, posts,
      payments, subscriptions, submissions, rating history) and then the user, all in one transaction. If any step fails, nothing is deleted.</div>` : ''}
    ${owned ? '<div class="note-box warn" style="margin-top:12px">This user set problems, wrote editorials or runs contests that other people depend on. Reassign or delete those first; a full delete will not remove them.</div>' : ''}
    <div id="udel-msg" style="margin-top:12px"></div>
    <div class="form-actions"><button class="btn" data-close>Keep</button>
      <button class="btn danger" id="udel-plain">${icon.trash} Delete user</button>
      ${blocked && !owned ? `<button class="btn danger solid" id="udel-purge">${icon.trash} Delete user and everything they own</button>` : ''}</div>`;
  const go = async (mode) => {
    $$('#udel-plain, #udel-purge', body).forEach((b) => { b.disabled = true; });
    try {
      const res = await api(`/api/admin/users/${u.user_id}${mode === 'purge' ? '?mode=purge' : ''}`, { method: 'DELETE' });
      closeModal(); closeDrawer();
      if (res.steps) {
        toast(`<b>${esc(res.message)}</b><br><span class="small">${res.steps.map((s) => `${esc(s.sql.split(' (')[0])}: ${s.rowCount}`).join('<br>')}</span>`, 'ok');
      } else ok(res);
      loadUsers();
    } catch (e) {
      formError($('#udel-msg', body), e);
      $$('#udel-purge', body).forEach((b) => { b.disabled = false; });
    }
  };
  $('#udel-plain', body).onclick = () => go('restrict');
  if ($('#udel-purge', body)) $('#udel-purge', body).onclick = () => go('purge');
}

// ================================================================ TOPICS & COMPANIES
const LOOKUPS = {
  topics: {
    label: 'Topic', key: 'topic_id', title: 'Topics', table: 'topics',
    fields: [{ name: 'topic_name', label: 'Topic name', max: 60, required: true }],
    cols: [
      { label: '#', num: true, render: (r) => `<span class="muted">${r.topic_id}</span>` },
      { label: 'Topic', render: (r) => `<span class="strong">${esc(r.topic_name)}</span>` },
      { label: 'Problems', num: true, key: 'problems' }, { label: 'Mastery rows', num: true, key: 'mastery_rows' }
    ],
    deleteNote: 'Its tags in <code>problem_topics</code> go with it (ON DELETE CASCADE). If solvers have <code>topic_mastery</code> rows for it, PostgreSQL refuses (no delete rule).'
  },
  companies: {
    label: 'Company', key: 'company_id', title: 'Companies', table: 'companies',
    fields: [
      { name: 'company_name', label: 'Company name', max: 100, required: true },
      { name: 'industry', label: 'Industry', max: 60 },
      { name: 'logo_url', label: 'Logo URL', max: 255 },
      { name: 'dynamic_trending_score', label: 'Trending score', type: 'number', hint: '0 to 100 (CHECK)' }
    ],
    cols: [
      { label: '#', num: true, render: (r) => `<span class="muted">${r.company_id}</span>` },
      { label: 'Company', render: (r) => `<span class="strong">${esc(r.company_name)}</span><div class="small muted">${esc(r.industry || '')}</div>` },
      { label: 'Trend', num: true, render: (r) => fmtNum(r.dynamic_trending_score, 2) },
      { label: 'Problems', num: true, key: 'problems' }, { label: 'Snapshots', num: true, key: 'snapshots' }
    ],
    deleteNote: 'Its tags in <code>problem_companies</code> and its <code>frequency_snapshots</code> go with it (ON DELETE CASCADE).'
  }
};

export async function pageCatalog(v) {
  if (adminOnly(v, 'Topics & Companies')) return;
  v.innerHTML = head({
    title: 'Topics & Companies', srs: ['CRUD · topics', 'CRUD · companies', 'Admin'],
    desc: 'The two lookup tables that problems are tagged with. Names are UNIQUE and IDs are primary keys, so a duplicate is refused by PostgreSQL.'
  }) + '<div class="grid g2"><div id="lk-topics"></div><div id="lk-companies"></div></div>';
  loadLookup('topics'); loadLookup('companies');
}

async function loadLookup(kind) {
  const L = LOOKUPS[kind]; const el = $(`#lk-${kind}`); if (!el) return;
  el.innerHTML = card(L.title, loading);
  try {
    const { rows } = await api(`/api/admin/${kind}`);
    el.innerHTML = card(`${L.title} · ${rows.length}`, `<div class="t-scroll" style="max-height:620px">${table(rows, L.cols, { onRow: true })}</div>`,
      { flush: true, sub: 'click a row to edit or delete', tools: `<button class="btn sm accent" id="lk-new-${kind}">${icon.plus} Add</button>` });
    bindRows(el, rows, (r) => lookupForm(kind, r));
    $(`#lk-new-${kind}`).onclick = () => lookupForm(kind);
  } catch (e) { el.innerHTML = card(L.title, errorBox(e)); }
}

function lookupForm(kind, row) {
  const L = LOOKUPS[kind]; const editing = Boolean(row);
  const body = openModal(editing ? `Edit ${L.label.toLowerCase()} #${row[L.key]}` : `Add a ${L.label.toLowerCase()}`, `
    <form class="form" id="lform" novalidate>
      ${editing ? '' : `<label class="full">${L.label} ID <span class="hint">optional · blank = next free id</span><input class="input" type="number" name="${L.key}" min="1" placeholder="auto"></label>`}
      ${L.fields.map((f) => `<label class="${L.fields.length === 1 || f.name.endsWith('_name') ? 'full' : ''}">${esc(f.label)}${f.hint ? ` <span class="hint">${esc(f.hint)}</span>` : ''}
        <input class="input" name="${f.name}" ${f.type === 'number' ? 'type="number" step="0.01"' : `maxlength="${f.max}"`} ${f.required ? 'required' : ''} value="${esc(row?.[f.name] ?? '')}"></label>`).join('')}
      <div class="form-error full" id="lform-err"></div>
    </form>
    ${editing ? `<div class="note-box small" style="margin-top:14px">${L.deleteNote}</div>` : ''}
    <div class="form-actions">${editing ? `<button class="btn danger" id="ldel" style="margin-right:auto">${icon.trash} Delete</button>` : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="lsave">${icon.check} ${editing ? 'Save' : 'Create'}</button></div>`);
  const done = (res) => { closeModal(); ok(res); loadLookup(kind); window.dispatchEvent(new CustomEvent('cp-meta-changed')); };
  $('#lsave', body).onclick = async () => {
    const payload = Object.fromEntries(new FormData($('#lform', body)).entries());
    try {
      done(editing ? await api(`/api/admin/${kind}/${row[L.key]}`, { method: 'PUT', body: payload })
        : await api(`/api/admin/${kind}`, { method: 'POST', body: payload }));
    } catch (e) { formError($('#lform-err', body), e); }
  };
  if (editing) {
    $('#ldel', body).onclick = async () => {
      if (!confirm(`Run DELETE FROM ${L.table} WHERE ${L.key} = ${row[L.key]}?`)) return;
      try { done(await api(`/api/admin/${kind}/${row[L.key]}`, { method: 'DELETE' })); } catch (e) { formError($('#lform-err', body), e); }
    };
  }
}

// ================================================================ SQL CONSOLE
const EXAMPLES = [
  ['Join 2 tables', `-- Each problem with its setter's username
SELECT p.problem_id, p.title, p.difficulty_level, u.username AS setter
FROM problems p
JOIN users u ON u.user_id = p.setter_id
ORDER BY p.problem_id
LIMIT 20;`],
  ['Join 3 tables', `-- Accepted submissions per user and problem
SELECT u.username, p.title, COUNT(*) AS accepted
FROM submissions s
JOIN users u    ON u.user_id = s.user_id
JOIN problems p ON p.problem_id = s.problem_id
WHERE s.verdict = 'AC'
GROUP BY u.username, p.title
ORDER BY accepted DESC
LIMIT 20;`],
  ['Group + HAVING', `-- Topics with more than 10 problems
SELECT t.topic_name, COUNT(*) AS problems
FROM topics t
JOIN problem_topics pt ON pt.topic_id = t.topic_id
GROUP BY t.topic_name
HAVING COUNT(*) > 10
ORDER BY problems DESC;`],
  ['INSERT', `INSERT INTO topics (topic_id, topic_name)
VALUES ((SELECT MAX(topic_id) + 1 FROM topics), 'Viva Demo Topic')
RETURNING *;`],
  ['UPDATE', `UPDATE topics SET topic_name = 'Viva Demo Topic (edited)'
WHERE topic_name = 'Viva Demo Topic'
RETURNING *;`],
  ['DELETE', `DELETE FROM topics
WHERE topic_name LIKE 'Viva Demo Topic%'
RETURNING *;`],
  ['Duplicate key', `-- topic_id 1 already exists, so the primary key refuses this
INSERT INTO topics (topic_id, topic_name) VALUES (1, 'Duplicate');`]
];
let consoleSql = EXAMPLES[0][1];
let consoleRollback = false;

export async function pageConsole(v) {
  if (adminOnly(v, 'SQL Console')) return;
  v.innerHTML = head({
    title: 'SQL Console', srs: ['Any query', 'Admin'],
    desc: 'Type any query and run it on the live database. One statement per run: SELECT and joins, plus INSERT, UPDATE and DELETE. ' +
      'DROP, ALTER, TRUNCATE and CREATE are blocked so the schema cannot be damaged from the GUI.'
  }) + `<section class="card fade-in mb"><div class="card-body">
      <div class="pill-row" style="margin-bottom:12px">${EXAMPLES.map(([l], i) => `<button class="btn sm" data-ex="${i}">${esc(l)}</button>`).join('')}</div>
      <textarea class="input mono sql-box" id="sql-in" spellcheck="false" aria-label="SQL statement">${esc(consoleSql)}</textarea>
      <div class="sql-bar">
        <button class="btn accent" id="sql-go">${icon.play} Run</button>
        <span class="small muted"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
        <label class="small sql-rb"><input type="checkbox" id="sql-rb" ${consoleRollback ? 'checked' : ''}> Roll back after running (try a change without keeping it)</label>
        <span class="small muted" id="sql-meta" style="margin-left:auto"></span>
      </div></div></section>
    <div id="sql-out"></div>`;
  const box = $('#sql-in');
  box.addEventListener('input', () => { consoleSql = box.value; });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runConsole(); }
    if (e.key === 'Tab') { e.preventDefault(); const s = box.selectionStart; box.setRangeText('  ', s, box.selectionEnd, 'end'); consoleSql = box.value; }
  });
  $('#sql-rb').addEventListener('change', (e) => { consoleRollback = e.target.checked; });
  $$('[data-ex]').forEach((b) => b.addEventListener('click', () => { box.value = consoleSql = EXAMPLES[Number(b.dataset.ex)][1]; box.focus(); }));
  $('#sql-go').onclick = runConsole;
}

async function runConsole() {
  const out = $('#sql-out'); const btn = $('#sql-go');
  out.innerHTML = `<section class="card">${loading}</section>`; btn.disabled = true; $('#sql-meta').textContent = '';
  try {
    const r = await api('/api/admin/sql', { method: 'POST', body: { sql: consoleSql, rollback: consoleRollback } });
    const state = r.readOnly ? 'read-only transaction' : r.rolledBack ? 'rolled back, nothing kept' : 'committed, check it in pgAdmin';
    $('#sql-meta').textContent = `${r.command} · ${r.rowCount ?? 0} row(s) · ${r.ms} ms · ${state}`;
    const banner = r.readOnly ? '' : `<div class="note-box ${r.rolledBack ? 'warn' : ''}" style="margin:16px 22px 0"><b>${esc(r.command)} ${r.rowCount ?? 0}</b> · ${r.rolledBack
      ? 'Rolled back: the change ran inside a transaction and was then undone.'
      : 'Committed: the change is saved in PostgreSQL. Refresh the table in pgAdmin to see it.'}</div>`;
    out.innerHTML = card('Data output', `${banner}${r.fields.length ? `<div class="t-scroll" style="margin-top:${banner ? 16 : 0}px">${autoTable(r.rows, r.fields)}</div>` : ''}
      ${r.rowCount > r.shown && r.fields.length ? `<div class="pager">Showing the first ${r.shown} of ${fmtNum(r.rowCount)} rows</div>` : ''}`,
      { flush: true, sub: r.fields.length ? `${r.fields.length} column(s)` : '' });
    if (!r.readOnly && !r.rolledBack) window.dispatchEvent(new CustomEvent('cp-meta-changed'));
  } catch (e) {
    $('#sql-meta').textContent = 'Error';
    const pos = Number(e.data?.position);
    let where = '';
    if (pos) {
      const before = consoleSql.slice(0, pos - 1); const line = before.split('\n').length;
      where = `<div class="small" style="margin-top:6px">At line ${line}, near <code>${esc(consoleSql.slice(pos - 1, pos + 19).split('\n')[0])}</code></div>`;
    }
    out.innerHTML = `<div class="note-box warn"><b>${e.data?.code ? 'PostgreSQL error' : 'Not run'}.</b> ${esc(e.message)}
      ${e.data?.code ? `<div class="small" style="margin-top:6px">SQLSTATE <code>${esc(e.data.code)}</code>${e.data.constraint ? ` · constraint <code>${esc(e.data.constraint)}</code>` : ''}</div>` : ''}${where}</div>`;
  } finally { btn.disabled = false; }
}

