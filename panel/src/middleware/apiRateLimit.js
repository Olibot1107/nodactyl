const { db } = require('../db');
const log = require('../log');

// Per-API-key sliding window rate limiter. Limits are read from DB (cached 30 s).
const _windows = new Map();
let _cache = null;
let _cacheAt = 0;

function getSettings() {
  const now = Date.now();
  if (_cache && now - _cacheAt < 30000) return _cache;
  const defaults = { api_rate_limit_enabled: '1', api_rate_limit_per_min: '60', api_rate_limit_per_hour: '1000' };
  try {
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('api_rate_limit_enabled','api_rate_limit_per_min','api_rate_limit_per_hour')"
    ).all();
    for (const r of rows) defaults[r.key] = r.value;
  } catch {}
  _cache = defaults;
  _cacheAt = now;
  return _cache;
}

// Prune stale tracking data every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, ts] of _windows) {
    const kept = ts.filter(t => t > cutoff);
    if (!kept.length) _windows.delete(id);
    else _windows.set(id, kept);
  }
}, 300000).unref();

function apiRateLimit(req, res, next) {
  const s = getSettings();
  if (s.api_rate_limit_enabled === '0') return next();

  const keyId = req.apiKeyId;
  if (!keyId) return next();

  const perMin  = Math.max(1, parseInt(s.api_rate_limit_per_min)  || 60);
  const perHour = Math.max(1, parseInt(s.api_rate_limit_per_hour) || 1000);
  const now = Date.now();

  const all    = (_windows.get(keyId) || []).filter(t => now - t < 3600000);
  const inMin  = all.filter(t => now - t < 60000).length;
  const inHour = all.length;

  if (inMin >= perMin) {
    log.warn('ratelimit', `API key ${keyId.slice(0, 8)} hit per-minute limit (${perMin}/min) on ${req.method} ${req.path}`);
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: `Rate limit exceeded: ${perMin} requests/min. Retry in 60 s.` });
  }
  if (inHour >= perHour) {
    log.warn('ratelimit', `API key ${keyId.slice(0, 8)} hit per-hour limit (${perHour}/hr) on ${req.method} ${req.path}`);
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: `Rate limit exceeded: ${perHour} requests/hour. Retry in 3600 s.` });
  }

  all.push(now);
  _windows.set(keyId, all);

  res.setHeader('X-RateLimit-Limit-Min',     perMin);
  res.setHeader('X-RateLimit-Remaining-Min', Math.max(0, perMin  - inMin  - 1));
  res.setHeader('X-RateLimit-Limit-Hour',    perHour);
  res.setHeader('X-RateLimit-Remaining-Hour',Math.max(0, perHour - inHour - 1));
  next();
}

module.exports = { apiRateLimit };
