const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const { db } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

authenticator.options = { window: 1 }; // allow 1-step clock skew tolerance

const router = express.Router();

function userWithRank(user) {
  const rank = user.rank_id
    ? db.prepare('SELECT id, name, color, max_servers FROM ranks WHERE id = ?').get(user.rank_id)
    : null;
  return { id: user.id, username: user.username, email: user.email, role: user.role, avatar: user.avatar || null, rank: rank || null };
}

function cookieOpts() { return { httpOnly: true, maxAge: 86400000, sameSite: 'strict' }; }

// ── Setup: generate secret + QR code ─────────────────────────────────────────
router.post('/setup', requireAuth, async (req, res) => {
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'totp_enabled'").get()?.value;
    if (setting === '0') return res.status(403).json({ error: '2FA has been disabled by the panel administrator' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

    const secret = authenticator.generateSecret();
    const panelName = db.prepare("SELECT value FROM settings WHERE key = 'panel_name'").get()?.value || 'Nodactyl';
    const otpauthUrl = authenticator.keyuri(user.username, panelName, secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauthUrl);

    // Store pending secret (not yet enabled)
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);

    res.json({ secret, qrCodeUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enable: verify a code then flip totp_enabled ─────────────────────────────
router.post('/enable', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  if (!user.totp_secret) return res.status(400).json({ error: 'No pending setup — call /setup first' });

  if (!authenticator.check(String(code), user.totp_secret)) {
    return res.status(400).json({ error: 'Invalid code — check your authenticator app and try again' });
  }

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// ── Disable: requires password confirmation ───────────────────────────────────
router.post('/disable', requireAuth, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Incorrect password' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// ── Verify: called during login when 2FA is required ─────────────────────────
router.post('/verify', (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code are required' });

  let payload;
  try {
    payload = jwt.verify(mfaToken, JWT_SECRET);
    if (payload.scope !== 'mfa') throw new Error('wrong scope');
  } catch {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || user.suspended) return res.status(401).json({ error: 'Account not found or suspended' });
  if (!user.totp_enabled || !user.totp_secret) return res.status(400).json({ error: 'Invalid request' });

  if (!authenticator.check(String(code), user.totp_secret)) {
    return res.status(401).json({ error: 'Invalid authentication code' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('token', token, cookieOpts());
  res.json({ token, user: userWithRank(user) });
});

module.exports = router;
