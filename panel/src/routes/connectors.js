const express = require('express');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── State store for CSRF protection ──────────────────────────────────────────
const stateStore = new Map();

function makeState(data) {
  const state = crypto.randomBytes(18).toString('hex');
  stateStore.set(state, { ...data, expires: Date.now() + 5 * 60 * 1000 });
  return state;
}

function consumeState(state) {
  const data = stateStore.get(state);
  stateStore.delete(state);
  if (!data || data.expires < Date.now()) return null;
  return data;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (v.expires < now) stateStore.delete(k);
  }
}, 600000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDiscordConfig() {
  const row = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
  return {
    clientId:     row('discord_client_id'),
    clientSecret: row('discord_client_secret'),
    redirectUri:  row('discord_redirect_uri'),
    enabled:      row('discord_enabled') === '1',
  };
}

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Bad Discord response')); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, authHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: authHeader },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Bad Discord response')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/connectors/status — current user's connector state (requireAuth)
router.get('/status', requireAuth, (req, res) => {
  const cfg = getDiscordConfig();
  const user = db.prepare('SELECT discord_id, discord_username FROM users WHERE id = ?').get(req.user.id);
  res.json({
    discord: {
      enabled: cfg.enabled && !!(cfg.clientId && cfg.clientSecret && cfg.redirectUri),
      linked: !!user?.discord_id,
      username: user?.discord_username || null,
    },
  });
});

// GET /api/connectors/discord/authorize?action=link|login
router.get('/discord/authorize', (req, res) => {
  const action = req.query.action === 'login' ? 'login' : 'link';
  const cfg = getDiscordConfig();
  if (!cfg.enabled || !cfg.clientId || !cfg.redirectUri) {
    return res.redirect('/connectors?error=not_configured');
  }

  let userId = null;
  if (action === 'link') {
    const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.redirect('/login');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch { return res.redirect('/login'); }
  }

  const state = makeState({ action, userId });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// GET /api/connectors/discord/callback?code=...&state=...
router.get('/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/connectors?error=' + encodeURIComponent(error));
  if (!code || !state) return res.redirect('/connectors?error=missing_params');

  const stateData = consumeState(state);
  if (!stateData) return res.redirect('/connectors?error=invalid_state');

  const cfg = getDiscordConfig();
  if (!cfg.clientSecret) return res.redirect('/connectors?error=not_configured');

  try {
    const tokenData = await httpsPost('https://discord.com/api/oauth2/token', {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
    });
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const discordUser = await httpsGet(
      'https://discord.com/api/users/@me',
      `Bearer ${tokenData.access_token}`
    );
    if (!discordUser.id) throw new Error('Could not get Discord user info');

    const displayName = discordUser.global_name || discordUser.username;

    if (stateData.action === 'link') {
      const conflict = db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').get(discordUser.id, stateData.userId);
      if (conflict) return res.redirect('/connectors?error=already_linked_other');

      db.prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?')
        .run(discordUser.id, displayName, stateData.userId);
      return res.redirect('/connectors?linked=1');
    } else {
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordUser.id);
      if (!user) return res.redirect('/login?discord_error=no_account');
      if (user.suspended) return res.redirect('/login?discord_error=suspended');

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      return res.redirect('/login?discord_token=' + encodeURIComponent(token));
    }
  } catch (err) {
    console.error('[connectors] Discord OAuth error:', err.message);
    const dest = stateData.action === 'login' ? '/login' : '/connectors';
    return res.redirect(dest + '?error=' + encodeURIComponent(err.message));
  }
});

// DELETE /api/connectors/discord — unlink account
router.delete('/discord', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
