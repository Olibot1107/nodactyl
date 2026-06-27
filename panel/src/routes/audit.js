const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const limit  = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);
  const userId   = req.query.user_id   || null;
  const serverId = req.query.server_id || null;
  const action   = req.query.action    || null;
  const username = req.query.username  || null;

  let where = [];
  let params = [];
  if (userId)   { where.push('al.user_id = ?');            params.push(userId); }
  if (serverId) { where.push('al.server_id = ?');          params.push(serverId); }
  if (action)   { where.push('al.action LIKE ?');          params.push(action + '%'); }
  if (username) { where.push('u.username LIKE ?');         params.push('%' + username + '%'); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const logs = db.prepare(`
    SELECT al.id, al.user_id, al.server_id, al.action, al.metadata, al.ip, al.created_at, al.api_key_id,
           u.username, u.avatar,
           s.name as server_name,
           ak.name as api_key_name
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN servers s ON al.server_id = s.id
    LEFT JOIN api_keys ak ON al.api_key_id = ak.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all([...params, limit, offset]);

  const total = db.prepare(`
    SELECT COUNT(*) as n FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN servers s ON al.server_id = s.id
    ${whereClause}
  `).get([...params])?.n ?? 0;

  res.json({
    logs: logs.map(l => ({ ...l, metadata: (() => { try { return JSON.parse(l.metadata || '{}'); } catch { return {}; } })() })),
    total,
    limit,
    offset,
  });
});

module.exports = router;
