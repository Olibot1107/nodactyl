const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');
const nodeManager = require('../nodeManager');
const { audit } = require('../audit');
const log = require('../log');

function ip(req) { return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '?'; }

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations from this IP. Try again later.' },
});

function cookieOpts() {
  return { httpOnly: true, maxAge: 86400000, sameSite: 'strict' };
}

function userWithRank(user) {
  const rank = user.rank_id
    ? db.prepare('SELECT id, name, color, max_servers FROM ranks WHERE id = ?').get(user.rank_id)
    : null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    avatar: user.avatar || null,
    rank: rank || null,
    totp_enabled: user.totp_enabled === 1,
    has_password: !!user.password && user.password !== '$oauth$',
  };
}

router.post('/register', registerLimiter, (req, res) => {
  if (process.env.REGISTRATION_OPEN !== 'true') {
    return res.status(403).json({ error: 'Registration is currently closed.' });
  }

  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required' });
  if (username.length < 3 || username.length > 32) return res.status(400).json({ error: 'Username must be 3–32 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(400).json({ error: 'Username or email is already taken' });

  const hashed = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  const defaultRank = db.prepare('SELECT id FROM ranks WHERE sort_order = 0 LIMIT 1').get();
  db.prepare('INSERT INTO users (id, username, email, password, role, rank_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, email, hashed, 'user', defaultRank?.id || null);
  log.ok('auth', `New user registered: "${username}" <${email}> from ${ip(req)}`);
  res.status(201).json({ ok: true });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    log.warn('auth', `Failed login for "${username}" from ${ip(req)}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.suspended) {
    log.warn('auth', `Login blocked — suspended user "${username}" from ${ip(req)}`);
    return res.status(403).json({ error: 'Your account has been suspended. Contact an administrator.' });
  }

  const totpGloballyEnabled = db.prepare("SELECT value FROM settings WHERE key = 'totp_enabled'").get()?.value;
  if (user.totp_enabled && totpGloballyEnabled !== '0') {
    const mfaToken = jwt.sign({ id: user.id, scope: 'mfa' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ requires2FA: true, mfaToken });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.cookie('token', token, cookieOpts());
  if (user.role !== 'admin') audit(user.id, null, 'auth.login', {}, req);
  log.ok('auth', `"${user.username}" logged in (${user.role}) from ${ip(req)}`);
  res.json({ token, user: userWithRank(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Refreshes the httpOnly cookie from a Bearer token (used before browser-navigation OAuth flows)
router.post('/set-cookie', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(400).json({ error: 'No token' });
  res.cookie('token', token, cookieOpts());
  res.json({ ok: true });
});

router.patch('/me', requireAuth, (req, res) => {
  const { username, avatar, current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];

  let usernameChanged = false;
  let passwordChanged = false;
  if (username !== undefined) {
    const trimmed = String(username).trim();
    if (trimmed.length < 3 || trimmed.length > 32) return res.status(400).json({ error: 'Username must be 3–32 characters' });
    const dupe = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmed, user.id);
    if (dupe) return res.status(400).json({ error: 'Username already taken' });
    updates.push('username = ?'); values.push(trimmed);
    usernameChanged = true;
  }

  if ('avatar' in req.body) {
    const av = avatar || null;
    if (av && av.length > 200000) return res.status(400).json({ error: 'Avatar too large (max ~200 KB)' });
    updates.push('avatar = ?'); values.push(av);
  }

  if (new_password !== undefined) {
    const isOauthOnly = !user.password || user.password === '$oauth$';
    if (!isOauthOnly) {
      if (!current_password) return res.status(400).json({ error: 'Current password is required' });
      if (!bcrypt.compareSync(current_password, user.password)) return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (String(new_password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updates.push('password = ?'); values.push(bcrypt.hashSync(new_password, 10));
    passwordChanged = true;
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (user.role !== 'admin') {
    if (usernameChanged) audit(user.id, null, 'auth.username_change', {}, req);
    if (passwordChanged) audit(user.id, null, 'auth.password_change', {}, req);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const out = { user: userWithRank(updated) };

  if (username !== undefined) {
    const token = jwt.sign(
      { id: updated.id, username: updated.username, role: updated.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.cookie('token', token, cookieOpts());
    out.token = token;
  }

  res.json(out);
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(userWithRank(user));
});

router.delete('/me', requireAuth, async (req, res) => {
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be self-deleted. Ask another admin to remove your account.' });

  const isOauthOnly = !user.password || user.password === '$oauth$';
  if (!isOauthOnly) {
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Incorrect password' });
  }

  const servers = db.prepare('SELECT * FROM servers WHERE owner_id = ?').all(req.user.id);

  const io = nodeManager.io;
  if (io) {
    for (const s of servers) {
      io.to(`user:${s.owner_id}`).to('admins').emit('server-deleted', { serverId: s.id });
      db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(s.id)
        .forEach(m => io.to(`user:${m.user_id}`).emit('server-deleted', { serverId: s.id }));
    }
  }

  await Promise.all(servers.map(s => {
    if (nodeManager.isOnline(s.node_id) && s.container_id) {
      return nodeManager.send(s.node_id, {
        type: 'delete-server', serverId: s.id, containerId: s.container_id,
      }, { timeout: 15000 }).catch(() => {});
    }
  }));

  db.prepare('DELETE FROM server_members WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM servers WHERE owner_id = ?').run(req.user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);

  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
