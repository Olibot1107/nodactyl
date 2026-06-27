const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Generate a random secret and add it to your .env or environment before starting the panel.');
  process.exit(1);
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Re-read from DB on every request: catches role changes and suspensions before token expires
    const user = db.prepare('SELECT id, username, role, suspended, rank_id FROM users WHERE id = ?').get(decoded.id);
    if (!user || user.suspended) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { ...decoded, role: user.role, rank_id: user.rank_id };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
