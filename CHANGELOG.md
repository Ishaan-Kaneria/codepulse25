# Changelog

## 1.4.0 · 17 Nov 2026

**Added (administrators only)**
- **Users** screen: add, edit and delete accounts, and set their roles (one row per role table). A duplicate username, email or user id is refused by PostgreSQL (`users_username_key`, `users_email_address_key`, `users_pkey`) and the error is shown on the form.
- Deleting a user lists every row that references them. A plain delete is blocked by foreign keys with no delete rule; **Delete user and everything they own** removes their posts, comments, reports, reviews, payments, subscriptions, submissions and rating history first, in one transaction. Users who set problems, wrote editorials or run contests must hand those over first.
- **Topics & Companies** screen: CRUD on both lookup tables.
- **SQL Console**: run any single statement, including joins, INSERT, UPDATE and DELETE, with an option to roll back. DDL (DROP, ALTER, TRUNCATE, CREATE …), multiple statements and server-side file or process functions are blocked; read-only statements run in a READ ONLY transaction with a 5 s timeout.
- The new-problem form has an optional **Problem ID**; a taken id is refused by `problems_pkey`.

**Changed**
- Constraint errors (23505, 23503, 23514, 23502) now come back as plain sentences with the SQLSTATE and constraint name.
- The smoke test covers all of the above.
- `SQL_CONSOLE_WRITES=off` (for public deployments) lets the console run changes only with "roll back" ticked.

## 1.3.0 · 15 Nov 2026

**Fixes**
- Profiles no longer send every user's email address to anyone who opens them. `users.profile` returns `email_address` only to the account itself and to staff.
- The latest payments and the renewal reminders (both list usernames) are now administrator-only. The Premium page shows a "Restricted" card for everyone else; revenue totals and plan counts stay public.
- Lab 10A query 21 used to run `CREATE OR REPLACE FUNCTION` on every click. It now creates `fn_user_acceptance_pct` only when it is missing, so viewing the gallery no longer changes the schema and two clicks at once cannot collide.
- `npm run db:load` drops the public schema, but it used to do so without asking. It now prints the target database and needs `--yes`.

**Added**
- `scripts/smoke-test.js` (`npm run test:smoke`): every screen query, all 30 Lab 10A queries, sign-in, role rules, problems CRUD and a moderation review.
- GitHub Actions CI: loads `db/01`–`03` into PostgreSQL 16, checks the Netlify migrations match them, and runs the smoke test.

## 1.2.0 · 14 Nov 2026
- bcrypt sign-in against `users.password_hash`, with roles read from the role tables.
- Public profiles at `#/u/<username>` and a People directory.
- The API enforces the schema's role rules: setters edit only their own problems, Premium gating from `feature_gating_rules`, moderation reviews by moderation leads only, hidden posts visible only to staff and authors.

## Earlier
- Redesigned frontend around the verdict stream, calmer overview chart, demo sign-in.
- Deployed on Netlify with Netlify Database (PostgreSQL).
- Lab 11: database connectivity, full CRUD on `problems`, a screen for each SRS function, and the 30 Lab 10A queries.
