const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');

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
  };
}

router.post('/register', registerLimiter, (req, res) => {
  if (process.env.REGISTRATION_OPEN !== 'true') {
    return res.status(403).json({ error: 'Registration is currently closed.' });
  }

  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(400).json({ error: 'Username or email is already taken' });

  const hashed = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  const defaultRank = db.prepare('SELECT id FROM ranks WHERE sort_order = 0 LIMIT 1').get();
  db.prepare('INSERT INTO users (id, username, email, password, role, rank_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, email, hashed, 'user', defaultRank?.id || null);

  res.status(201).json({ ok: true });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.suspended) {
    return res.status(403).json({ error: 'Your account has been suspended. Contact an administrator.' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.cookie('token', token, cookieOpts());
  res.json({ token, user: userWithRank(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.patch('/me', requireAuth, (req, res) => {
  const { username, avatar, current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];

  if (username !== undefined) {
    const trimmed = String(username).trim();
    if (trimmed.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    const dupe = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmed, user.id);
    if (dupe) return res.status(400).json({ error: 'Username already taken' });
    updates.push('username = ?'); values.push(trimmed);
  }

  if ('avatar' in req.body) {
    const av = avatar || null;
    if (av && av.length > 200000) return res.status(400).json({ error: 'Avatar too large (max ~200 KB)' });
    updates.push('avatar = ?'); values.push(av);
  }

  if (new_password !== undefined) {
    if (!current_password) return res.status(400).json({ error: 'Current password is required' });
    if (!bcrypt.compareSync(current_password, user.password)) return res.status(400).json({ error: 'Current password is incorrect' });
    if (String(new_password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updates.push('password = ?'); values.push(bcrypt.hashSync(new_password, 10));
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

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

module.exports = router;
