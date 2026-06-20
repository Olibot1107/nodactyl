const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');

const router = express.Router();

function userWithRank(user) {
  const rank = user.rank_id
    ? db.prepare('SELECT id, name, color, max_servers FROM ranks WHERE id = ?').get(user.rank_id)
    : null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    rank: rank || null,
  };
}

router.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields are required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(400).json({ error: 'Username or email is already taken' });

  const hashed = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)').run(id, username, email, hashed, 'user');

  res.status(201).json({ ok: true });
});

router.post('/login', (req, res) => {
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

  res.cookie('token', token, { httpOnly: false, maxAge: 86400000, sameSite: 'lax' });
  res.json({ token, user: userWithRank(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(userWithRank(user));
});

module.exports = router;
