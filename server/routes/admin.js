// server/routes/admin.js - administrator-only screens:
//   * users CRUD with their role rows (users + solvers / problem_setters / contest_managers / moderation_leads / platform_administrators)
//   * topics and companies CRUD
//   * a SQL console for ad-hoc queries (one statement, no DDL)
// Every value from a form goes through $1, $2 ... placeholders. UPDATE and DELETE always have a WHERE on the primary key.
// Duplicate keys, foreign keys and CHECKs are left to PostgreSQL; server/app.js turns its errors into plain messages.
const express = require('express');
const bcrypt = require('bcryptjs');
const { run, pool, withTransaction } = require('../db');
const { rolesOf } = require('./auth');

const router = express.Router();

// Middleware: administrators only (read from platform_administrators on every request).
router.use(async (req, res, next) => {
  try {
    const roles = await rolesOf(req.user.uid);
    if (!roles.admin) return res.status(403).json({ error: 'Only platform administrators can open this screen.' });
    next();
  } catch (err) { next(err); }
});

const toInt = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const nullIfEmpty = (v) => { v = clean(v); return v === '' || v === undefined ? null : v; };
const MAX_INT = 2147483647;
const badId = (v) => v !== null && (!Number.isInteger(v) || v < 1 || v > MAX_INT);

// ================================================================ USERS
const ROLE_TABLES = {
  solver: 'solvers', setter: 'problem_setters', manager: 'contest_managers',
  moderator: 'moderation_leads', admin: 'platform_administrators'
};
const ROLE_LABELS = { solver: 'Solver', setter: 'Problem setter', manager: 'Contest manager', moderator: 'Moderation lead', admin: 'Administrator' };

const USER_SQL = `
  SELECT u.user_id, u.username, u.email_address, u.country, u.registration_date, u.last_login_timestamp,
         u.session_count, u.contribution_point,
         EXISTS (SELECT 1 FROM solvers x WHERE x.user_id = u.user_id)          AS solver,
         EXISTS (SELECT 1 FROM problem_setters x WHERE x.user_id = u.user_id)  AS setter,
         EXISTS (SELECT 1 FROM contest_managers x WHERE x.user_id = u.user_id) AS manager,
         EXISTS (SELECT 1 FROM moderation_leads x WHERE x.user_id = u.user_id) AS moderator,
         EXISTS (SELECT 1 FROM platform_administrators x WHERE x.user_id = u.user_id) AS admin,
         (SELECT clearance_level FROM platform_administrators x WHERE x.user_id = u.user_id) AS clearance_level
  FROM users u`;

// READ (list) with search and paging
router.get('/users', async (req, res, next) => {
  try {
    const q = nullIfEmpty(req.query.q);
    const size = Math.min(Math.max(toInt(req.query.size) || 20, 5), 100);
    const page = Math.max(toInt(req.query.page) || 1, 1);
    const { rows } = await run(
      `SELECT *, COUNT(*) OVER ()::int AS total_count FROM (${USER_SQL}) x
        WHERE ($1::text IS NULL OR username ILIKE '%' || $1 || '%' OR email_address ILIKE '%' || $1 || '%'
               OR user_id::text = $1 OR country ILIKE '%' || $1 || '%')
        ORDER BY user_id DESC LIMIT $2 OFFSET $3`, [q, size, (page - 1) * size]);
    res.json({ rows: rows.map(({ total_count, ...r }) => r), total: rows[0]?.total_count || 0, page, size });
  } catch (err) { next(err); }
});

// READ (one)
router.get('/users/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (badId(id) || id === null) return res.status(400).json({ error: 'User id must be a positive whole number.' });
    const { rows } = await run(`${USER_SQL} WHERE u.user_id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: `User ${id} was not found.` });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

function validateUser(body, creating) {
  const errors = [];
  const roles = body.roles || {};
  const data = {
    user_id: toInt(body.user_id),
    username: clean(body.username) || '',
    email_address: (clean(body.email_address) || '').toLowerCase(),
    country: nullIfEmpty(body.country),
    password: typeof body.password === 'string' ? body.password : '',
    roles: Object.fromEntries(Object.keys(ROLE_TABLES).map((k) => [k, Boolean(roles[k])])),
    clearance_level: toInt(body.clearance_level)
  };
  if (creating && badId(data.user_id)) errors.push('User ID must be a whole number from 1 to 2147483647, or left blank.');
  if (!/^[A-Za-z0-9_]{3,30}$/.test(data.username)) errors.push('Username needs 3 to 30 letters, digits or underscores.');
  if (data.email_address.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email_address)) errors.push('Enter a valid email address (max 100 characters).');
  if (data.country && data.country.length > 50) errors.push('Country can be at most 50 characters.');
  if (creating && data.password.length < 6) errors.push('Password needs at least 6 characters.');
  if (!creating && data.password && data.password.length < 6) errors.push('A new password needs at least 6 characters (leave it blank to keep the old one).');
  if (data.password.length > 72) errors.push('Password can be at most 72 characters.');
  // CHECK (clearance_level BETWEEN 1 AND 5) is also in the schema; this just gives a nicer message first.
  if (data.roles.admin && data.clearance_level === null) errors.push('An administrator needs a clearance level (1 to 5).');
  return { data, errors };
}

// The sign-in matches usernames and emails case-insensitively, so "Parth_Modi" must not sit next to "parth_modi".
// An exact duplicate is left to the UNIQUE constraints, so the database itself raises the error.
async function caseClash(client, data, exceptId) {
  const { rows } = await client.query(
    `SELECT username, email_address FROM users
      WHERE user_id IS DISTINCT FROM $3
        AND ((lower(username) = lower($1) AND username <> $1) OR (lower(email_address) = lower($2) AND email_address <> $2))`,
    [data.username, data.email_address, exceptId]);
  if (!rows[0]) return null;
  return lowerEq(rows[0].username, data.username)
    ? `Username "${data.username}" is already taken (as "${rows[0].username}"; sign-in ignores letter case).`
    : `Email address "${data.email_address}" is already taken (sign-in ignores letter case).`;
}
const lowerEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Add or remove rows in the five role tables so they match the form.
async function saveRoles(client, userId, roles, clearance) {
  const changes = [];
  for (const [key, table] of Object.entries(ROLE_TABLES)) {
    const has = (await client.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [userId])).rowCount > 0;
    if (roles[key] && !has) {
      if (key === 'admin') await client.query('INSERT INTO platform_administrators (user_id, clearance_level) VALUES ($1, $2)', [userId, clearance]);
      else await client.query(`INSERT INTO ${table} (user_id) VALUES ($1)`, [userId]);
      changes.push(`INSERT INTO ${table}`);
    } else if (!roles[key] && has) {
      try {
        await client.query('SAVEPOINT drop_role');
        await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        await client.query('RELEASE SAVEPOINT drop_role');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT drop_role');
        if (err.code === '23503') {
          throw Object.assign(new Error(
            `The ${ROLE_LABELS[key]} role cannot be removed: ${err.detail || err.message} ` +
            `PostgreSQL blocked DELETE FROM ${table} because other rows still reference it (${err.constraint}).`),
          { status: 409, code: err.code, constraint: err.constraint });
        }
        throw err;
      }
      changes.push(`DELETE FROM ${table}`);
    } else if (key === 'admin' && has) {
      const upd = await client.query(
        'UPDATE platform_administrators SET clearance_level = $2 WHERE user_id = $1 AND clearance_level IS DISTINCT FROM $2', [userId, clearance]);
      if (upd.rowCount) changes.push('UPDATE platform_administrators');
    }
  }
  return changes;
}

// CREATE
router.post('/users', async (req, res, next) => {
  const { data, errors } = validateUser(req.body || {}, true);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const hash = await bcrypt.hash(data.password, 10);
    const out = await withTransaction(async (client) => {
      const clash = await caseClash(client, data, null);
      if (clash) throw Object.assign(new Error(clash), { status: 409 });
      // user_id has no sequence in the schema. A typed id is inserted as-is (a taken id hits users_pkey);
      // a blank id takes the next free number while the table is locked.
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const ins = await client.query(
        `INSERT INTO users (user_id, username, email_address, password_hash, registration_date, country)
         SELECT COALESCE($1::int, (SELECT COALESCE(MAX(user_id), 0) + 1 FROM users)), $2, $3, $4, CURRENT_DATE, $5
         RETURNING user_id, username`,
        [data.user_id, data.username, data.email_address, hash, data.country]);
      const changes = await saveRoles(client, ins.rows[0].user_id, data.roles, data.clearance_level);
      return { ...ins.rows[0], rowCount: ins.rowCount, changes };
    });
    console.log(`INSERT users -> user_id ${out.user_id} (${out.changes.join(', ') || 'no roles'})`);
    res.status(201).json({ message: `User ${out.username} (#${out.user_id}) created.`, ...out });
  } catch (err) { next(err); }
});

// UPDATE
router.put('/users/:id', async (req, res, next) => {
  const id = toInt(req.params.id);
  if (badId(id) || id === null) return res.status(400).json({ error: 'User id must be a positive whole number.' });
  const { data, errors } = validateUser(req.body || {}, false);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  if (id === req.user.uid && !data.roles.admin) return res.status(400).json({ error: 'You cannot remove your own administrator role.' });
  try {
    const hash = data.password ? await bcrypt.hash(data.password, 10) : null;
    const out = await withTransaction(async (client) => {
      const clash = await caseClash(client, data, id);
      if (clash) throw Object.assign(new Error(clash), { status: 409 });
      const upd = await client.query(
        `UPDATE users SET username = $1, email_address = $2, country = $3, password_hash = COALESCE($4, password_hash)
          WHERE user_id = $5`, [data.username, data.email_address, data.country, hash, id]);
      if (!upd.rowCount) return { notFound: true };
      const changes = await saveRoles(client, id, data.roles, data.clearance_level);
      return { rowCount: upd.rowCount, changes };
    });
    if (out.notFound) return res.status(404).json({ error: `User ${id} was not found.` });
    console.log(`UPDATE users WHERE user_id = ${id} -> rowCount ${out.rowCount} (${out.changes.join(', ') || 'roles unchanged'})`);
    res.json({ message: `User #${id} updated${hash ? ' (new password set)' : ''}.`, ...out });
  } catch (err) { next(err); }
});

// What still points at a user. "blockers" are foreign keys with no delete rule (they stop DELETE FROM users);
// "owned" is content other people depend on, which a full delete will not remove; "cascade" goes automatically.
const DEPENDENTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM posts WHERE user_id = $1)::int                     AS posts,
    (SELECT COUNT(*) FROM comments WHERE user_id = $1)::int                  AS comments,
    (SELECT COUNT(*) FROM flag_reports WHERE reporter_id = $1)::int          AS flag_reports,
    (SELECT COUNT(*) FROM subscriptions WHERE user_id = $1)::int             AS subscriptions,
    (SELECT COUNT(*) FROM payments p JOIN subscriptions s USING (subscription_id) WHERE s.user_id = $1)::int AS payments,
    (SELECT COUNT(*) FROM submissions WHERE user_id = $1)::int               AS submissions,
    (SELECT COUNT(*) FROM rating_history WHERE user_id = $1)::int            AS rating_history,
    (SELECT COUNT(*) FROM moderator_reviews WHERE moderator_id = $1)::int    AS moderator_reviews,
    (SELECT COUNT(*) FROM problems WHERE setter_id = $1)::int                AS problems_set,
    (SELECT COUNT(*) FROM editorials WHERE setter_id = $1)::int              AS editorials_written,
    (SELECT COUNT(*) FROM contests WHERE manager_id = $1)::int               AS contests_managed,
    (SELECT COUNT(*) FROM follows WHERE follower_id = $1 OR followee_id = $1)::int AS follows,
    (SELECT COUNT(*) FROM reactions WHERE user_id = $1)::int                 AS reactions,
    (SELECT COUNT(*) FROM user_badges WHERE user_id = $1)::int               AS user_badges,
    (SELECT COUNT(*) FROM participations WHERE user_id = $1)::int            AS participations,
    (SELECT COUNT(*) FROM enrolments WHERE user_id = $1)::int                AS enrolments,
    (SELECT COUNT(*) FROM topic_mastery WHERE user_id = $1)::int             AS topic_mastery`;
const BLOCKER_KEYS = {
  posts: 'posts.user_id', comments: 'comments.user_id', flag_reports: 'flag_reports.reporter_id', subscriptions: 'subscriptions.user_id',
  submissions: 'submissions.user_id → solvers', rating_history: 'rating_history → participations', moderator_reviews: 'moderator_reviews.moderator_id → moderation_leads'
};
const OWNED_KEYS = { problems_set: 'problems.setter_id → problem_setters', editorials_written: 'editorials.setter_id → problem_setters', contests_managed: 'contests.manager_id → contest_managers' };
const CASCADE_KEYS = ['follows', 'reactions', 'user_badges', 'participations', 'enrolments', 'topic_mastery'];

async function dependents(id, client = pool) {
  const d = (await client.query(DEPENDENTS_SQL, [id])).rows[0];
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, d[k]]).filter(([, n]) => n > 0));
  return {
    counts: d,
    blockers: pick(Object.keys(BLOCKER_KEYS)),
    owned: pick(Object.keys(OWNED_KEYS)),
    cascade: pick(CASCADE_KEYS),
    via: { ...BLOCKER_KEYS, ...OWNED_KEYS }
  };
}
router.get('/users/:id/dependents', async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    if (badId(id) || id === null) return res.status(400).json({ error: 'User id must be a positive whole number.' });
    res.json(await dependents(id));
  } catch (err) { next(err); }
});

// DELETE   ?mode=restrict (default): one DELETE FROM users; PostgreSQL refuses if a foreign key still points at the user.
//          ?mode=purge: also delete the user's own activity first, in one transaction.
router.delete('/users/:id', async (req, res, next) => {
  const id = toInt(req.params.id);
  if (badId(id) || id === null) return res.status(400).json({ error: 'User id must be a positive whole number.' });
  if (id === req.user.uid) return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
  const purge = req.query.mode === 'purge';
  try {
    if (!purge) {
      const result = await run('DELETE FROM users WHERE user_id = $1', [id]);
      if (!result.rowCount) return res.status(404).json({ error: `User ${id} was not found.` });
      console.log(`DELETE FROM users WHERE user_id = ${id} -> rowCount ${result.rowCount}`);
      return res.json({ message: `User #${id} deleted. Their role rows, follows, reactions, badges, enrolments and contest entries went with it (ON DELETE CASCADE).`, rowCount: result.rowCount });
    }
    const out = await withTransaction(async (client) => {
      const exists = await client.query('SELECT username FROM users WHERE user_id = $1 FOR UPDATE', [id]);
      if (!exists.rowCount) return { status: 404, body: { error: `User ${id} was not found.` } };
      const dep = await dependents(id, client);
      if (Object.keys(dep.owned).length) {
        return { status: 409, body: {
          error: `${exists.rows[0].username} still owns content other people depend on (${Object.entries(dep.owned).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}). ` +
                 'Give it to another setter or manager, or delete it, before deleting this account.', ...dep } };
      }
      const steps = [];
      const step = async (label, sql) => { const r = await client.query(sql, [id]); steps.push({ sql: label, rowCount: r.rowCount }); };
      // Children first, so no foreign key is left dangling. Order matters: reviews -> reports -> posts.
      await step('DELETE FROM moderator_reviews (by the user, or on reports by/about them)',
        `DELETE FROM moderator_reviews WHERE moderator_id = $1
            OR report_id IN (SELECT report_id FROM flag_reports WHERE reporter_id = $1
                             OR post_id IN (SELECT post_id FROM posts WHERE user_id = $1))`);
      await step('DELETE FROM flag_reports (by the user, or on their posts)',
        'DELETE FROM flag_reports WHERE reporter_id = $1 OR post_id IN (SELECT post_id FROM posts WHERE user_id = $1)');
      await step('DELETE FROM comments (replies cascade)', 'DELETE FROM comments WHERE user_id = $1');
      await step('DELETE FROM posts (their comments and reactions cascade)', 'DELETE FROM posts WHERE user_id = $1');
      await step('DELETE FROM payments', 'DELETE FROM payments WHERE subscription_id IN (SELECT subscription_id FROM subscriptions WHERE user_id = $1)');
      await step('DELETE FROM subscriptions', 'DELETE FROM subscriptions WHERE user_id = $1');
      await step('DELETE FROM submissions (failure logs cascade)', 'DELETE FROM submissions WHERE user_id = $1');
      await step('DELETE FROM rating_history', 'DELETE FROM rating_history WHERE user_id = $1');
      await step('DELETE FROM users (role rows, follows, reactions, badges, participations, enrolments cascade)', 'DELETE FROM users WHERE user_id = $1');
      return { status: 200, body: { message: `User ${exists.rows[0].username} (#${id}) and everything they owned were deleted in one transaction.`, steps, rowCount: 1 } };
    });
    if (out.status === 200) console.log(`PURGE user ${id}: ${out.body.steps.map((s) => s.rowCount).join('/')}`);
    res.status(out.status).json(out.body);
  } catch (err) {
    if (err.code === '23503') {
      const dep = await dependents(id).catch(() => null);
      return res.status(409).json({
        error: `User #${id} cannot be deleted: other rows still reference them. PostgreSQL blocked the DELETE (${err.constraint}).`,
        code: err.code, constraint: err.constraint, detail: err.detail, ...(dep || {})
      });
    }
    next(err);
  }
});

// ================================================================ TOPICS and COMPANIES
// One small CRUD factory for both lookup tables.
function lookupCrud({ path, table, key, label, fields, countsSql, onDeleteNote }) {
  const validate = (body, creating) => {
    const errors = [];
    const data = { id: toInt(body[key]) };
    if (creating && badId(data.id)) errors.push(`${label} ID must be a whole number from 1 to 2147483647, or left blank.`);
    for (const f of fields) {
      let v = nullIfEmpty(body[f.name]);
      if (v !== null && f.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) { errors.push(`${f.label} must be a number.`); continue; }
      }
      if (f.required && v === null) errors.push(`${f.label} is required.`);
      if (typeof v === 'string' && f.max && v.length > f.max) errors.push(`${f.label} can be at most ${f.max} characters.`);
      data[f.name] = v;
    }
    return { data, errors };
  };
  const cols = fields.map((f) => f.name);

  router.get(`/${path}`, async (req, res, next) => {
    try { res.json({ rows: (await run(countsSql)).rows }); } catch (err) { next(err); }
  });
  router.post(`/${path}`, async (req, res, next) => {
    const { data, errors } = validate(req.body || {}, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    try {
      const row = await withTransaction(async (client) => {
        await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
        const r = await client.query(
          `INSERT INTO ${table} (${key}, ${cols.join(', ')})
           SELECT COALESCE($1::int, (SELECT COALESCE(MAX(${key}), 0) + 1 FROM ${table})), ${cols.map((_, i) => `$${i + 2}`).join(', ')}
           RETURNING ${key} AS id`, [data.id, ...cols.map((c) => data[c])]);
        return { id: r.rows[0].id, rowCount: r.rowCount };
      });
      console.log(`INSERT ${table} -> ${key} ${row.id}`);
      res.status(201).json({ message: `${label} #${row.id} created.`, ...row });
    } catch (err) { next(err); }
  });
  router.put(`/${path}/:id`, async (req, res, next) => {
    const id = toInt(req.params.id);
    if (badId(id) || id === null) return res.status(400).json({ error: `${label} id must be a positive whole number.` });
    const { data, errors } = validate(req.body || {}, false);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    try {
      const r = await run(`UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE ${key} = $${cols.length + 1}`,
        [...cols.map((c) => data[c]), id]);
      if (!r.rowCount) return res.status(404).json({ error: `${label} ${id} was not found.` });
      console.log(`UPDATE ${table} WHERE ${key} = ${id} -> rowCount ${r.rowCount}`);
      res.json({ message: `${label} #${id} updated.`, rowCount: r.rowCount });
    } catch (err) { next(err); }
  });
  router.delete(`/${path}/:id`, async (req, res, next) => {
    const id = toInt(req.params.id);
    if (badId(id) || id === null) return res.status(400).json({ error: `${label} id must be a positive whole number.` });
    try {
      const r = await run(`DELETE FROM ${table} WHERE ${key} = $1`, [id]);
      if (!r.rowCount) return res.status(404).json({ error: `${label} ${id} was not found.` });
      console.log(`DELETE FROM ${table} WHERE ${key} = ${id} -> rowCount ${r.rowCount}`);
      res.json({ message: `${label} #${id} deleted. ${onDeleteNote}`, rowCount: r.rowCount });
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({ error: `${label} #${id} cannot be deleted: ${err.detail || 'other rows still reference it.'} PostgreSQL blocked the DELETE (${err.constraint}).`, code: err.code, constraint: err.constraint });
      }
      next(err);
    }
  });
}

lookupCrud({
  path: 'topics', table: 'topics', key: 'topic_id', label: 'Topic',
  fields: [{ name: 'topic_name', label: 'Topic name', required: true, max: 60 }],
  countsSql: `SELECT t.topic_id, t.topic_name,
                     (SELECT COUNT(*) FROM problem_topics x WHERE x.topic_id = t.topic_id)::int AS problems,
                     (SELECT COUNT(*) FROM topic_mastery x WHERE x.topic_id = t.topic_id)::int  AS mastery_rows
              FROM topics t ORDER BY t.topic_id`,
  onDeleteNote: 'Its problem tags went with it (problem_topics, ON DELETE CASCADE).'
});
lookupCrud({
  path: 'companies', table: 'companies', key: 'company_id', label: 'Company',
  fields: [
    { name: 'company_name', label: 'Company name', required: true, max: 100 },
    { name: 'industry', label: 'Industry', max: 60 },
    { name: 'logo_url', label: 'Logo URL', max: 255 },
    { name: 'dynamic_trending_score', label: 'Trending score', type: 'number' }   // CHECK 0..100 is in the schema
  ],
  countsSql: `SELECT c.company_id, c.company_name, c.industry, c.logo_url, c.dynamic_trending_score,
                     (SELECT COUNT(*) FROM problem_companies x WHERE x.company_id = c.company_id)::int  AS problems,
                     (SELECT COUNT(*) FROM frequency_snapshots x WHERE x.company_id = c.company_id)::int AS snapshots
              FROM companies c ORDER BY c.company_id`,
  onDeleteNote: 'Its problem tags and frequency snapshots went with it (ON DELETE CASCADE).'
});

// ================================================================ SQL CONSOLE
// One statement per run. SELECT / WITH / INSERT / UPDATE / DELETE / EXPLAIN / VALUES / TABLE / SHOW are allowed;
// schema changes (DROP, ALTER, TRUNCATE, CREATE ...) and server-side file / process functions are refused.
// It runs inside a transaction with a 5 s statement timeout, and can be rolled back instead of committed.

// Blank out comments and quoted text so keyword checks never trip on, or miss, text inside them.
function skeleton(sql) {
  let out = ''; let i = 0;
  while (i < sql.length) {
    const c = sql[i]; const two = sql.slice(i, i + 2);
    if (two === '--') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; out += ' '; continue; }
    if (two === '/*') {
      let depth = 1; i += 2;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw Object.assign(new Error('A /* comment is never closed.'), { status: 400 });
      out += ' '; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw Object.assign(new Error(`A ${c === "'" ? 'string' : 'quoted name'} is never closed.`), { status: 400 });
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += c === "'" ? " '' " : ' "x" '; i = j + 1; continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw Object.assign(new Error('A $$ string is never closed.'), { status: 400 });
      out += " '' "; i = end + dollar[0].length; continue;
    }
    out += c; i++;
  }
  return out;
}

const ALLOWED_FIRST = ['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'EXPLAIN', 'VALUES', 'TABLE', 'SHOW'];
const BLOCKED_WORDS = /\b(DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|LISTEN|NOTIFY|PREPARE|DEALLOCATE|DISCARD)\b/i;
const BLOCKED_FUNCS = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|lo_import|lo_export|lo_\w+|set_config|dblink\w*|pg_advisory\w*|pg_sleep\w*|pg_promote|pg_switch_wal|pg_create_\w+|pg_drop_\w+|query_to_xml\w*)\s*\(/i;

function checkConsoleSql(raw) {
  const sql = String(raw || '').trim();
  if (!sql) throw Object.assign(new Error('Type a SQL statement first.'), { status: 400 });
  if (sql.length > 20000) throw Object.assign(new Error('That statement is too long (20,000 characters max).'), { status: 400 });
  const bare = skeleton(sql).replace(/[\s;]+$/, '');
  if (bare.includes(';')) throw Object.assign(new Error('Run one statement at a time (remove the extra semicolons).'), { status: 400 });
  const first = (bare.trim().match(/^\(*\s*([A-Za-z]+)/) || [])[1]?.toUpperCase();
  if (!ALLOWED_FIRST.includes(first)) {
    throw Object.assign(new Error(`"${first || bare.trim().slice(0, 12)}" statements are not allowed here. The console runs ${ALLOWED_FIRST.join(', ')}; schema changes stay in pgAdmin.`), { status: 400 });
  }
  const word = bare.match(BLOCKED_WORDS);
  if (word) throw Object.assign(new Error(`${word[1].toUpperCase()} is blocked in the console, so the schema cannot be changed or damaged from the GUI.`), { status: 400 });
  const fn = bare.match(BLOCKED_FUNCS);
  if (fn) throw Object.assign(new Error(`The function ${fn[1]}() is blocked in the console.`), { status: 400 });
  // SELECT ... INTO creates a new table, so it counts as a schema change.
  if (/\bINTO\b/i.test(bare.replace(/\bINSERT\s+INTO\b/ig, ''))) {
    throw Object.assign(new Error('SELECT ... INTO creates a table, so it is blocked in the console. Use INSERT INTO ... SELECT instead.'), { status: 400 });
  }
  const writes = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(bare);
  return { sql: sql.replace(/;\s*$/, ''), writes };
}

router.post('/sql', async (req, res, next) => {
  let checked;
  try { checked = checkConsoleSql(req.body?.sql); } catch (err) { return next(err); }
  const rollback = Boolean(req.body?.rollback);
  // On a public deployment, set SQL_CONSOLE_WRITES=off so console changes can only be tried with "roll back".
  if (checked.writes && !rollback && String(process.env.SQL_CONSOLE_WRITES || '').toLowerCase() === 'off') {
    return res.status(403).json({ error: 'Saving changes from the SQL console is turned off on this site (SQL_CONSOLE_WRITES=off). ' +
      'Tick "Roll back after running" to try the INSERT, UPDATE or DELETE without keeping it. The other screens still save normally.' });
  }
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('BEGIN');
    if (!checked.writes) await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    // queryMode "extended" sends a single prepared statement, so PostgreSQL itself refuses a second statement.
    const result = await client.query({ text: checked.sql, queryMode: 'extended' });
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
    const ms = Date.now() - started;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    console.log(`SQL console (${req.user.name}): ${result.command} rowCount ${result.rowCount}${rollback ? ' [rolled back]' : ''}`);
    res.json({
      command: result.command, rowCount: result.rowCount, rows: rows.slice(0, 500), shown: Math.min(rows.length, 500),
      fields: (result.fields || []).map((f) => f.name), ms, committed: !rollback && checked.writes, rolledBack: rollback,
      readOnly: !checked.writes
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '25006') err.message = 'This looks like a read-only query, but it tried to change data. Write the INSERT, UPDATE or DELETE explicitly.';
    if (err.code === '57014') err.message = 'The query ran longer than 5 seconds and was cancelled.';
    err.status = err.status || (err.code && /^(22|23|42|25|57|0A|2B|40|55)/.test(err.code) ? 400 : 500);
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.checkConsoleSql = checkConsoleSql;
