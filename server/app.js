// server/app.js - the Express REST API. Used by server/index.js (local) and netlify/functions/api.mjs (deployed).
const express = require('express');
const path = require('path');
const { run, pool } = require('./db');
const { Q, AS_OF } = require('./queries/srs');
const LAB10A = require('./queries/lab10a');
const problems = require('./routes/problems');
const auth = require('./routes/auth');
const moderation = require('./routes/moderation');

const app = express();
app.use(express.json({ limit: '200kb' }));

const api = express.Router();
api.use(auth.attachUser);   // req.user is set when a valid token is sent; nothing is rejected here

// Connection check: SELECT version()
api.get('/health', async (req, res, next) => {
  try {
    const started = Date.now();
    const { rows } = await run(
      `SELECT version() AS version, current_database() AS database, current_user AS db_user,
              (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables`);
    res.json({ ok: true, ...rows[0], as_of: AS_OF, ms: Date.now() - started,
               mode: (process.env.DATABASE_URL || process.env.NETLIFY_DB_URL) ? 'hosted (database URL)' : 'local (PG* settings)' });
  } catch (err) { next(err); }
});

// Sign-in
api.use('/auth', auth);

// Moderation reviews (moderation leads only)
api.use('/moderation', auth.requireUser, moderation);

// Main table CRUD (writes need a signed-in administrator or problem setter)
api.use('/problems', (req, res, next) => (req.method === 'GET' ? next() : auth.requireUser(req, res, () => auth.requireEditor(req, res, next))), problems);

// Named read-only queries for every SRS screen: GET /api/q/<key>?param=value
function readParams(def, query, ctx = {}) {
  const values = [];
  for (const prm of def.params || []) {
    // Values marked "server" (who is asking, and their role) come from the verified token, never from the URL.
    if (prm.server) { values.push(ctx[prm.server] ?? null); continue; }
    let raw = query[prm.name];
    if (raw === undefined || raw === '') raw = prm.default !== undefined ? String(prm.default) : null;
    let v = null;
    if (raw !== null) {
      if (prm.type === 'int') {
        v = Number.parseInt(raw, 10);
        if (!Number.isInteger(v)) throw Object.assign(new Error(`${prm.name} must be a whole number.`), { status: 400 });
      } else if (prm.type === 'bool') {
        v = raw === 'true' || raw === '1';
      } else if (prm.type === 'enum') {
        if (!prm.values.includes(raw)) throw Object.assign(new Error(`${prm.name} must be one of ${prm.values.join(', ')}.`), { status: 400 });
        v = raw;
      } else {
        v = String(raw).slice(0, 100);
      }
    }
    if (prm.required && v === null) throw Object.assign(new Error(`${prm.name} is required.`), { status: 400 });
    values.push(v);
  }
  return values;
}

api.get('/q/:key', async (req, res, next) => {
  try {
    const def = Q[req.params.key];
    if (!def) return res.status(404).json({ error: `Unknown query "${req.params.key}".` });
    const roles = await auth.rolesOf(req.user?.uid);
    // Role-restricted screens (for example the moderation queue).
    if (def.roles && !def.roles.some((r) => roles[r])) {
      return res.status(403).json({ error: def.denied || 'Your role cannot open this.', restricted: def.roles });
    }
    // Premium-gated editorials follow feature_gating_rules like problems do.
    if (def.gate === 'editorial') {
      const g = await run(`SELECT e.setter_id, r.minimum_access_level::text AS level FROM editorials e
                           LEFT JOIN feature_gating_rules r ON r.rule_id = e.rule_id WHERE e.editorial_id = $1`,
                          [Number.parseInt(req.query.editorial_id, 10) || null]);
      const access = g.rows[0] ? auth.contentAccess(req.user, roles, g.rows[0].level, g.rows[0].setter_id) : { allowed: true };
      if (!access.allowed) return res.status(403).json({ error: access.reason, locked: { needs: access.needs } });
    }
    const values = readParams(def, req.query, { viewer: req.user?.uid ?? null, staff: Boolean(roles.moderator || roles.admin) });
    const started = Date.now();
    const result = await run(def.sql, values);
    res.json({ key: req.params.key, srs: def.srs, rows: result.rows, rowCount: result.rowCount,
               fields: result.fields.map((f) => f.name), ms: Date.now() - started });
  } catch (err) { next(err); }
});

// Show the SQL behind a screen (read-only, for learning)
api.get('/sql/:key', (req, res) => {
  const def = Q[req.params.key];
  if (!def) return res.status(404).json({ error: 'Unknown query.' });
  res.json({ key: req.params.key, srs: def.srs, sql: def.sql.replace(/^ {6,10}/gm, '  '),
             params: (def.params || []).map((x) => x.name) });
});

// Lab 10A query gallery
api.get('/lab10a', (req, res) => {
  res.json(LAB10A.map(({ id, kind, title, english, srs, sql, pre }) => ({ id, kind, title, english, srs, sql, pre })));
});
api.get('/lab10a/:id', async (req, res, next) => {
  try {
    const item = LAB10A.find((x) => x.id === Number.parseInt(req.params.id, 10));
    if (!item) return res.status(404).json({ error: 'Query not found.' });
    if (item.pre) await run(item.pre);           // e.g. CREATE OR REPLACE FUNCTION used by query 21
    const started = Date.now();
    const result = await run(item.sql);
    res.json({ id: item.id, rows: result.rows.slice(0, 200), rowCount: result.rowCount,
               fields: result.fields.map((f) => f.name), ms: Date.now() - started });
  } catch (err) { next(err); }
});

app.use('/api', api);
app.use('/.netlify/functions/api', api);   // path seen inside the Netlify Function

// Static frontend (local / Codespace). On Netlify the CDN serves /public directly.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Errors -> JSON, with a plain-English hint for common connection problems
app.use((err, req, res, next) => {
  const hints = {
    ECONNREFUSED: 'PostgreSQL is not running or the host/port in .env is wrong.',
    '28P01': 'Password authentication failed. Check PGUSER / PGPASSWORD.',
    '3D000': 'The database name in .env does not exist.',
    '42P01': 'A table is missing. Run db/01_create_tables.sql and db/02_insert_data.sql first.',
    ENOTFOUND: 'The database host could not be found. Check PGHOST or DATABASE_URL.'
  };
  const status = err.status || (err.code && /^(22|23)/.test(err.code) ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, code: err.code, hint: hints[err.code] });
});

module.exports = app;
module.exports.pool = pool;
