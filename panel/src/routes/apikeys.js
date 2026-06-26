const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_KEYS_PER_USER = 10;

// List API keys (never returns the actual key value)
router.get('/', (req, res) => {
  const keys = db.prepare(
    'SELECT id, name, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json(keys);
});

// Create a new API key — returns the key ONCE
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim().slice(0, 64);

  const count = db.prepare('SELECT COUNT(*) as n FROM api_keys WHERE user_id = ?').get(req.user.id)?.n ?? 0;
  if (count >= MAX_KEYS_PER_USER)
    return res.status(400).json({ error: `Maximum of ${MAX_KEYS_PER_USER} API keys per account` });

  const id = uuidv4();
  const key = 'ndl_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO api_keys (id, key, name, user_id) VALUES (?, ?, ?, ?)').run(id, key, trimmed, req.user.id);

  res.status(201).json({ id, name: trimmed, key });
});

// Revoke an API key
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

module.exports = router;
