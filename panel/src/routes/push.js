const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPublicKey, sendBroadcastPush } = require('../push');

const router = express.Router();

router.get('/vapid-key', (req, res) => {
  const key = getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications not available' });
  res.json({ publicKey: key });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
  if (!keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'keys.p256dh and keys.auth required' });
  const id = uuidv4();
  db.prepare(`INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.user.id, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

router.delete('/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, endpoint);
  res.json({ ok: true });
});

router.get('/stats', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const total = db.prepare('SELECT COUNT(*) as n FROM push_subscriptions').get().n;
  const users = db.prepare('SELECT COUNT(DISTINCT user_id) as n FROM push_subscriptions').get().n;
  res.json({ total, users });
});

router.post('/broadcast', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { title, body, url } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
  if (!body  || typeof body  !== 'string' || !body.trim())  return res.status(400).json({ error: 'body required' });
  const safeUrl = typeof url === 'string' && url.startsWith('/') ? url : '/dashboard';
  try {
    const result = await sendBroadcastPush(title.trim(), body.trim(), safeUrl);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
