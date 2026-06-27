const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const ranks = db.prepare('SELECT * FROM ranks ORDER BY sort_order ASC, name ASC').all();
  res.json(ranks);
});

router.post('/', requireAdmin, (req, res) => {
  const { name, color = '#6366f1', max_servers = 1, memory_limit = 0, disk_limit = 0, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const existing = db.prepare('SELECT id FROM ranks WHERE name = ?').get(name);
  if (existing) return res.status(400).json({ error: 'A rank with that name already exists' });

  const id = uuidv4();
  const parsedMax = parseInt(max_servers);
  db.prepare('INSERT INTO ranks (id, name, color, max_servers, memory_limit, disk_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, color, Math.max(-1, Number.isFinite(parsedMax) ? parsedMax : 1), Math.max(0, parseInt(memory_limit) || 0), Math.max(0, parseInt(disk_limit) || 0), sort_order);
  res.status(201).json(db.prepare('SELECT * FROM ranks WHERE id = ?').get(id));
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM ranks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, color, max_servers, memory_limit, disk_limit, sort_order } = req.body;

  if (name && name !== existing.name) {
    const dupe = db.prepare('SELECT id FROM ranks WHERE name = ? AND id != ?').get(name, req.params.id);
    if (dupe) return res.status(400).json({ error: 'A rank with that name already exists' });
  }

  db.prepare('UPDATE ranks SET name=?, color=?, max_servers=?, memory_limit=?, disk_limit=?, sort_order=? WHERE id=?')
    .run(
      name ?? existing.name,
      color ?? existing.color,
      max_servers !== undefined ? Math.max(-1, Number.isFinite(parseInt(max_servers)) ? parseInt(max_servers) : 1) : existing.max_servers,
      memory_limit !== undefined ? Math.max(0, parseInt(memory_limit) || 0) : existing.memory_limit,
      disk_limit !== undefined ? Math.max(0, parseInt(disk_limit) || 0) : existing.disk_limit,
      sort_order ?? existing.sort_order,
      req.params.id,
    );
  res.json(db.prepare('SELECT * FROM ranks WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  // Clear rank from any users assigned to it first
  db.prepare('UPDATE users SET rank_id = NULL WHERE rank_id = ?').run(req.params.id);
  const result = db.prepare('DELETE FROM ranks WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
