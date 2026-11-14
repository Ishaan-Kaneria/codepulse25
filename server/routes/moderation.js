// server/routes/moderation.js
// Close a flag report with a review (SRS 9). moderator_reviews.moderator_id REFERENCES moderation_leads,
// so only moderation leads may review; administrators can view the queue but not sign a review.
const express = require('express');
const { withTransaction } = require('../db');
const { rolesOf } = require('./auth');

const router = express.Router();
const DECISIONS = ['Approved', 'Hidden', 'Removed', 'Locked'];   // decision_t

// POST /api/moderation/reviews  { report_id, decision, action_taken, note }
router.post('/reviews', async (req, res, next) => {
  try {
    const roles = await rolesOf(req.user.uid);
    if (!roles.moderator) {
      return res.status(403).json({ error: 'Only moderation leads can review reports (moderator_reviews.moderator_id references moderation_leads).' });
    }
    const reportId = Number.parseInt(req.body?.report_id, 10);
    const decision = req.body?.decision;
    const action = String(req.body?.action_taken || '').trim().slice(0, 60);
    const note = String(req.body?.note || '').trim().slice(0, 255) || null;
    const errors = [];
    if (!Number.isInteger(reportId)) errors.push('Choose a report.');
    if (!DECISIONS.includes(decision)) errors.push(`Decision must be one of ${DECISIONS.join(', ')}.`);
    if (!action) errors.push('Describe the action taken (up to 60 characters).');
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const result = await withTransaction(async (client) => {
      // review_id has no sequence, so take the next number while holding the table lock.
      await client.query('LOCK TABLE moderator_reviews IN SHARE ROW EXCLUSIVE MODE');
      const report = await client.query(
        `SELECT fr.report_id, fr.post_id,
                EXISTS (SELECT 1 FROM moderator_reviews mr WHERE mr.report_id = fr.report_id) AS reviewed
         FROM flag_reports fr WHERE fr.report_id = $1`, [reportId]);
      if (!report.rowCount) return { status: 404, body: { error: `Report ${reportId} was not found.` } };
      if (report.rows[0].reviewed) return { status: 409, body: { error: `Report ${reportId} has already been reviewed.` } };

      const ins = await client.query(
        `INSERT INTO moderator_reviews (review_id, report_id, moderator_id, action_taken, final_decision, decision_note, review_timestamp)
         SELECT COALESCE(MAX(review_id), 0) + 1, $1, $2, $3, $4::decision_t, $5, NOW()
         FROM moderator_reviews
         RETURNING review_id`, [reportId, req.user.uid, action, decision, note]);
      // The post takes the decision as its new status (decision_t values are also post_status_t values).
      const upd = await client.query(
        'UPDATE posts SET post_status = $1::text::post_status_t WHERE post_id = $2', [decision, report.rows[0].post_id]);
      return { status: 201, body: {
        message: `Report ${reportId} closed as ${decision}.`, review_id: ins.rows[0].review_id,
        rowCount: ins.rowCount, postsUpdated: upd.rowCount } };
    });
    if (result.status === 201) console.log(`INSERT moderator_reviews -> review ${result.body.review_id}, report ${reportId}, ${decision}`);
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

module.exports = router;
