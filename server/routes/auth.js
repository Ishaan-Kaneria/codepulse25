// server/routes/auth.js
// Sign-in against the users table. The password is checked with bcrypt against users.password_hash
// (db/03_demo_passwords.sql gives every sample account the demo password "codepulse").
// Roles come from the role tables (platform_administrators, problem_setters, ...).
// The server returns an HMAC-signed token; the browser sends it back as "Authorization: Bearer <token>".
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { run } = require('../db');

const router = express.Router();
const SECRET = process.env.AUTH_SECRET || 'codepulse-local-dev-secret';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function issue(user) {
  const body = b64(JSON.stringify({ uid: user.user_id, name: user.username, exp: Date.now() + TTL_MS }));
  return `${body}.${sign(body)}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!same(mac, sign(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

// Middleware: allow the request only with a valid token.
function requireUser(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = verify(token);
  if (!user) return res.status(401).json({ error: 'Sign in to change data. Your session may have expired.' });
  req.user = user;
  next();
}

// Middleware: only administrators and problem setters may create, edit or delete problems.
// The check reads the role tables on every request, so a role change in the database applies at once.
async function requireEditor(req, res, next) {
  try {
    const { rows } = await run(
      `SELECT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = $1)
           OR EXISTS (SELECT 1 FROM problem_setters WHERE user_id = $1) AS ok`, [req.user.uid]);
    if (!rows[0].ok) return res.status(403).json({ error: 'Only administrators and problem setters can change problems. Your account is read-only here.' });
    next();
  } catch (err) { next(err); }
}

const PROFILE_SQL = `
  SELECT u.user_id, u.username, u.country, u.contribution_point,
         (EXISTS (SELECT 1 FROM platform_administrators x WHERE x.user_id = u.user_id)
          OR EXISTS (SELECT 1 FROM problem_setters x WHERE x.user_id = u.user_id)) AS can_edit,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN EXISTS (SELECT 1 FROM platform_administrators x WHERE x.user_id = u.user_id) THEN 'Administrator' END,
           CASE WHEN EXISTS (SELECT 1 FROM problem_setters x WHERE x.user_id = u.user_id) THEN 'Problem setter' END,
           CASE WHEN EXISTS (SELECT 1 FROM contest_managers x WHERE x.user_id = u.user_id) THEN 'Contest manager' END,
           CASE WHEN EXISTS (SELECT 1 FROM moderation_leads x WHERE x.user_id = u.user_id) THEN 'Moderation lead' END,
           CASE WHEN EXISTS (SELECT 1 FROM solvers x WHERE x.user_id = u.user_id) THEN 'Solver' END
         ], NULL) AS roles
  FROM users u`;

// POST /api/auth/login  { username, password }   (username may also be the email address)
router.post('/login', async (req, res, next) => {
  const login = String(req.body?.username || '').trim().slice(0, 100);
  const password = String(req.body?.password || '');
  if (!login || !password) return res.status(400).json({ error: 'Enter a username and a password.' });
  try {
    const { rows } = await run(
      `SELECT p.*, u.password_hash FROM (${PROFILE_SQL}) p JOIN users u USING (user_id)
        WHERE lower(u.username) = lower($1) OR lower(u.email_address) = lower($1)`, [login]);
    // bcrypt.compare runs even for an unknown user, so the response time does not reveal which usernames exist.
    const hash = rows[0] ? rows[0].password_hash.trim() : '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DOLKXbdRk7gY9DnAXYpZf9QkB9n6i';
    const ok = await bcrypt.compare(password, hash);
    if (!rows[0] || !ok) return res.status(401).json({ error: 'That username and password do not match.' });
    delete rows[0].password_hash;
    // Record the sign-in in the database (parameterised, WHERE on the primary key).
    await run('UPDATE users SET last_login_timestamp = NOW(), session_count = session_count + 1 WHERE user_id = $1', [rows[0].user_id]);
    res.json({ token: issue(rows[0]), user: rows[0] });
  } catch (err) { next(err); }
});

// GET /api/auth/me  -> who the token belongs to
router.get('/me', requireUser, async (req, res, next) => {
  try {
    const { rows } = await run(`${PROFILE_SQL} WHERE u.user_id = $1`, [req.user.uid]);
    if (!rows[0]) return res.status(401).json({ error: 'This account no longer exists.' });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.requireUser = requireUser;
module.exports.requireEditor = requireEditor;
