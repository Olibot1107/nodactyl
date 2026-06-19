const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all();
  res.json(nodes.map(n => ({ ...n, online: nodeManager.isOnline(n.id) })));
});

router.get('/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  res.json({ ...node, online: nodeManager.isOnline(node.id) });
});

router.post('/', (req, res) => {
  const { name, description, memory = 4096, cpu = 4 } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');

  db.prepare(`INSERT INTO nodes (id, name, description, token, memory, cpu) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, name, description || '', token, memory, cpu);

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  res.status(201).json(node);
});

router.delete('/:id', (req, res) => {
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
router.post('/:id/reset-token', (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare('UPDATE nodes SET token = ? WHERE id = ?').run(token, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ token });
});

module.exports = router;
