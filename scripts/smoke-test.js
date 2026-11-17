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

  // A typed problem id that is already taken is refused by the primary key
  const dupProblem = await call('/problems', { method: 'POST', body: { ...form, problem_id: 1 }, token: admin });
  check(dupProblem.status === 409 && dupProblem.data.constraint === 'problems_pkey', 'a taken problem id is refused (problems_pkey)');

  // Admin: users CRUD
  check((await call('/admin/users', { token: solver })).status === 403, 'a solver cannot open the users screen');
  const newUser = { username: 'smoke_user', email_address: 'smoke@example.com', password: 'secret1', roles: { solver: true } };
  const dupName = await call('/admin/users', { method: 'POST', body: { ...newUser, username: 'parth_modi' }, token: admin });
  check(dupName.status === 409 && dupName.data.constraint === 'users_username_key', 'a duplicate username is refused (users_username_key)');
  const dupUid = await call('/admin/users', { method: 'POST', body: { ...newUser, user_id: 1 }, token: admin });
  check(dupUid.status === 409 && dupUid.data.constraint === 'users_pkey', 'a taken user id is refused (users_pkey)');
  const madeUser = await call('/admin/users', { method: 'POST', body: newUser, token: admin });
  check(madeUser.status === 201, 'administrator creates a user', madeUser.data.message);
  const uid = madeUser.data.user_id;
  const editedUser = await call(`/admin/users/${uid}`, { method: 'PUT', token: admin,
    body: { ...newUser, password: '', country: 'India', roles: { solver: true, setter: true } } });
  check(editedUser.status === 200 && editedUser.data.changes.includes('INSERT INTO problem_setters'), 'administrator edits the user and adds a role');
  const login = await call('/auth/login', { method: 'POST', body: { username: 'smoke_user', password: 'secret1' } });
  check(login.status === 200, 'the new user can sign in');
  const blocked = await call('/admin/users/82', { method: 'DELETE', token: admin });
  check(blocked.status === 409 && blocked.data.blockers?.posts >= 1, 'deleting a user with posts is blocked by a foreign key');
  const dropUser = await call(`/admin/users/${uid}`, { method: 'DELETE', token: admin });
  check(dropUser.status === 200 && dropUser.data.rowCount === 1, 'administrator deletes the user');

  // Admin: topics CRUD
  const dupTopic = await call('/admin/topics', { method: 'POST', body: { topic_name: 'Arrays' }, token: admin });
  check(dupTopic.status === 409, 'a duplicate topic name is refused');
  const topic = await call('/admin/topics', { method: 'POST', body: { topic_name: 'Smoke Topic' }, token: admin });
  check(topic.status === 201, 'administrator creates a topic');
  check((await call(`/admin/topics/${topic.data.id}`, { method: 'PUT', body: { topic_name: 'Smoke Topic 2' }, token: admin })).status === 200, 'administrator renames it');
  check((await call(`/admin/topics/${topic.data.id}`, { method: 'DELETE', token: admin })).status === 200, 'administrator deletes it');
  const badScore = await call('/admin/companies', { method: 'POST', body: { company_name: 'Smoke Co', dynamic_trending_score: 150 }, token: admin });
  check(badScore.status === 400 && badScore.data.code === '23514', 'a CHECK constraint violation is reported');

  // Admin: SQL console
  const sql = (text, rollback = false) => call('/admin/sql', { method: 'POST', body: { sql: text, rollback }, token: admin });
  const join = await sql('SELECT u.username, p.title FROM problems p JOIN users u ON u.user_id = p.setter_id LIMIT 3');
  check(join.status === 200 && join.data.rowCount === 3, 'console runs a join');
  check((await sql('DROP TABLE users')).status === 400, 'console blocks DROP');
  check((await sql('SELECT 1; DELETE FROM users')).status === 400, 'console blocks a second statement');
  const rb = await sql('UPDATE users SET country = country WHERE user_id = 82', true);
  check(rb.status === 200 && rb.data.rolledBack && rb.data.rowCount === 1, 'console can roll a change back');
  check((await call('/admin/sql', { method: 'POST', body: { sql: 'SELECT 1' }, token: solver })).status === 403, 'a solver cannot use the console');

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
