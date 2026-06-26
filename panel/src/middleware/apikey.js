const { db } = require('../db');

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
  const row = db.prepare(`
    SELECT ak.id, ak.user_id, u.role, u.suspended
    FROM api_keys ak JOIN users u ON ak.user_id = u.id
    WHERE ak.key = ?
  `).get(key);
  if (!row || row.suspended) return res.status(401).json({ error: 'Invalid or revoked API key' });
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), row.id);
  req.user = { id: String(row.user_id), role: row.role };
  req.apiKeyId = row.id;
  next();
}

module.exports = { requireApiKey };
