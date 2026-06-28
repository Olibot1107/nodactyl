const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PUBLIC_KEYS = ['panel_name', 'panel_logo', 'discord_enabled', 'github_enabled', 'totp_enabled', 'passkeys_enabled', 'api_enabled', 'pwa_enabled'];

// Public — no auth required
router.get('/public', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${PUBLIC_KEYS.map(() => '?').join(',')})`)
    .all(...PUBLIC_KEYS);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

// All settings — admin only
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key ASC').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

// Update settings — admin only
router.patch('/', requireAuth, requireAdmin, (req, res) => {
  const updates = req.body;
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Body must be a key-value object' });
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (value === null || value === '') {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      continue;
    }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 300000) return res.status(400).json({ error: 'Value too large (max ~300 KB)' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, trimmed);
  }

  res.json({ ok: true });
});

module.exports = router;
