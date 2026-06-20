const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all();
  const isAdmin = req.user.role === 'admin';
  res.json(nodes.map(n => {
    const base = { id: n.id, name: n.name, online: nodeManager.isOnline(n.id) };
    const sc = db.prepare('SELECT COUNT(*) as c FROM servers WHERE node_id = ?').get(n.id);
    base.server_count = sc?.c ?? 0;
    if (!isAdmin) return base;
    const alloc = db.prepare(`
      SELECT COALESCE(SUM(memory_limit), 0) as used_memory,
             COALESCE(SUM(CASE WHEN disk_limit > 0 THEN disk_limit ELSE 0 END), 0) as used_disk,
             COUNT(*) as server_count
      FROM servers WHERE node_id = ?
    `).get(n.id);
    return {
      ...n,
      ...base,
      used_memory: alloc?.used_memory ?? 0,
      used_disk:   alloc?.used_disk ?? 0,
      server_count: alloc?.server_count ?? 0,
    };
  }));
});

router.get('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  res.json({ ...node, online: nodeManager.isOnline(node.id) });
});

router.post('/', requireAdmin, (req, res) => {
  const { name, description, memory = 4096, cpu = 4, disk_limit = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');

  db.prepare(`INSERT INTO nodes (id, name, description, token, memory, cpu, disk_limit) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, description || '', token, memory, cpu, Math.max(0, parseInt(disk_limit) || 0));

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  res.status(201).json(node);
});

router.patch('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const { name, description, memory, cpu, disk_limit } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name.trim() || node.name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (memory !== undefined) { updates.push('memory = ?'); values.push(Math.max(0, parseInt(memory) || 0)); }
  if (cpu !== undefined) { updates.push('cpu = ?'); values.push(Math.max(0, parseInt(cpu) || 0)); }
  if (disk_limit !== undefined) { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });

  const serverCount = db.prepare('SELECT COUNT(*) as count FROM servers WHERE node_id = ?').get(req.params.id);
  if (serverCount.count > 0) {
    return res.status(400).json({ error: 'Cannot delete node with active servers' });
  }

  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Regenerate token
router.post('/:id/reset-token', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare('UPDATE nodes SET token = ? WHERE id = ?').run(token, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ token });
});

module.exports = router;
