// scripts/smoke-test.js - checks the running API end to end: every named query, every Lab 10A query,
// sign-in, the role rules, and the problems CRUD cycle. Used by GitHub Actions (.github/workflows/ci.yml).
// Run it against a server whose database was just loaded:  npm start  &  npm run test:smoke
// It creates one problem and deletes it again, and closes one moderation report.
const { Q } = require('../server/queries/srs');

const BASE = (process.env.API_URL || 'http://localhost:3000') + '/api';
const sample = { user_id: 82, submission_id: 5, contest_id: 1, editorial_id: 1, post_id: 1, company_id: 1,
                 plan_id: 1, rule_id: 1, username: 'parth_modi' };
let failures = 0;

function check(ok, label, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures += 1;
}

async function call(path, { token, method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function signIn(username) {
  const r = await call('/auth/login', { method: 'POST', body: { username, password: 'codepulse' } });
  return r.data.token;
}

(async () => {
  const health = await call('/health');
  check(health.status === 200 && health.data.tables === 42, 'health: 42 tables', `tables=${health.data.tables}`);

  const admin = await signIn('parth_modi');
  const solver = await signIn('vaishnavi_zaveri');      // user 82, a plain solver
  check(Boolean(admin && solver), 'demo sign-in works for an administrator and a solver');
  const bad = await call('/auth/login', { method: 'POST', body: { username: 'parth_modi', password: 'wrong' } });
  check(bad.status === 401, 'wrong password is refused');

  // Every named query must run for an administrator (role-restricted ones included).
  for (const [key, def] of Object.entries(Q)) {
    const qs = new URLSearchParams();
    for (const p of def.params || []) if (!p.server && sample[p.name] !== undefined) qs.set(p.name, sample[p.name]);
    const r = await call(`/q/${key}?${qs}`, { token: admin });
    check(r.status === 200, `query ${key}`, r.status === 200 ? `${r.data.rowCount} rows` : r.data.error);
  }

  // Role rules
  for (const key of ['moderation.queue', 'premium.payments', 'premium.expiring']) {
    const r = await call(`/q/${key}`);
    check(r.status === 403, `${key} is closed to visitors`);
  }
  const anonEmail = (await call('/q/users.profile?user_id=82')).data.rows[0].email_address;
  const selfEmail = (await call('/q/users.profile?user_id=82', { token: solver })).data.rows[0].email_address;
  check(anonEmail === null && Boolean(selfEmail), 'email is shown only to its owner and staff');

  // Lab 10A
  const lab = (await call('/lab10a')).data;
  check(Array.isArray(lab) && lab.length === 30, 'Lab 10A lists 30 queries');
  for (const item of lab || []) {
    const r = await call(`/lab10a/${item.id}`);
    check(r.status === 200, `Lab 10A query ${item.id}`, r.status === 200 ? `${r.data.rowCount} rows` : r.data.error);
  }

  // Problems CRUD
  const form = { title: 'Smoke test problem', full_description: 'Created by scripts/smoke-test.js', difficulty_level: 'Easy',
                 setter_id: 321, time_limit_ms: 1000, memory_limit_mb: 256, topic_ids: [1], company_ids: [] };
  check((await call('/problems', { method: 'POST', body: form })).status === 401, 'create needs a sign-in');
  check((await call('/problems', { method: 'POST', body: form, token: solver })).status === 403, 'a solver cannot create problems');
  const created = await call('/problems', { method: 'POST', body: form, token: admin });
  check(created.status === 201, 'administrator creates a problem', created.data.message);
  const id = created.data.problem_id;
  const updated = await call(`/problems/${id}`, { method: 'PUT', body: { ...form, title: 'Smoke test, edited' }, token: admin });
  check(updated.status === 200 && updated.data.rowCount === 1, 'administrator updates it');
  const read = await call(`/problems/${id}`);
  check(read.data.problem?.title === 'Smoke test, edited', 'the update is read back');
  const removed = await call(`/problems/${id}`, { method: 'DELETE', token: admin });
  check(removed.status === 200 && removed.data.rowCount === 1, 'administrator deletes it');
  check((await call('/problems/1', { method: 'DELETE', token: admin })).status === 409, 'a foreign key protects problem 1');

  // Moderation review
  const queue = (await call('/q/moderation.queue', { token: admin })).data.rows;
  if (queue.length) {
    const body = { report_id: queue[0].report_id, decision: 'Hidden', action_taken: 'Smoke test' };
    check((await call('/moderation/reviews', { method: 'POST', body, token: solver })).status === 403, 'a solver cannot review reports');
    check((await call('/moderation/reviews', { method: 'POST', body, token: admin })).status === 201, 'a moderation lead closes a report');
    check((await call('/moderation/reviews', { method: 'POST', body, token: admin })).status === 409, 'a report cannot be reviewed twice');
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
