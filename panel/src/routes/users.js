const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.suspended, u.rank_id, u.avatar, u.created_at,
           r.name as rank_name, r.color as rank_color
    FROM users u
    LEFT JOIN ranks r ON u.rank_id = r.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

router.post('/:id/suspend', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot suspend yourself' });
  const result = db.prepare('UPDATE users SET suspended = 1 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.post('/:id/unsuspend', (req, res) => {
  const result = db.prepare('UPDATE users SET suspended = 0 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.patch('/:id/role', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
  const { role } = req.body;
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.patch('/:id/rank', (req, res) => {
  const { rank_id } = req.body;
  // rank_id can be null to clear
  if (rank_id !== null && rank_id !== undefined) {
    const rank = db.prepare('SELECT id FROM ranks WHERE id = ?').get(rank_id);
    if (!rank) return res.status(404).json({ error: 'Rank not found' });
  }
  const result = db.prepare('UPDATE users SET rank_id = ? WHERE id = ?').run(rank_id || null, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Cannot delete admin accounts' });

  const servers = db.prepare('SELECT * FROM servers WHERE owner_id = ?').all(req.params.id);
  await Promise.all(servers.map(s => {
    if (nodeManager.isOnline(s.node_id) && s.container_id) {
      return nodeManager.send(s.node_id, {
        type: 'delete-server', serverId: s.id, containerId: s.container_id,
      }, { timeout: 15000 }).catch(() => {});
    }
  }));

  db.prepare('DELETE FROM servers WHERE owner_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
