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

// ── Config helpers ────────────────────────────────────────────────────────────
function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

function getDiscordConfig() {
  return {
    clientId:     getSetting('discord_client_id'),
    clientSecret: getSetting('discord_client_secret'),
    redirectUri:  getSetting('discord_redirect_uri'),
    enabled:      getSetting('discord_enabled') === '1',
  };
}

function getGithubConfig() {
  return {
    clientId:     getSetting('github_client_id'),
    clientSecret: getSetting('github_client_secret'),
    redirectUri:  getSetting('github_redirect_uri'),
    enabled:      getSetting('github_enabled') === '1',
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsPost(url, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Bad response from server')); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, authHeader, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: authHeader, ...extraHeaders },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Bad response from server')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper: extract JWT userId from request (cookie or Bearer header)
function getUserIdFromReq(req) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET).id; } catch { return null; }
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  const discordCfg = getDiscordConfig();
  const githubCfg  = getGithubConfig();
  const user = db.prepare('SELECT discord_id, discord_username, github_id, github_username FROM users WHERE id = ?').get(req.user.id);
  res.json({
    discord: {
      enabled: discordCfg.enabled && !!(discordCfg.clientId && discordCfg.clientSecret && discordCfg.redirectUri),
      linked:   !!user?.discord_id,
      username: user?.discord_username || null,
    },
    github: {
      enabled: githubCfg.enabled && !!(githubCfg.clientId && githubCfg.clientSecret && githubCfg.redirectUri),
      linked:   !!user?.github_id,
      username: user?.github_username || null,
    },
  });
});

// ── Discord ───────────────────────────────────────────────────────────────────
router.get('/discord/authorize', (req, res) => {
  const action = req.query.action === 'login' ? 'login' : 'link';
  const cfg = getDiscordConfig();
  if (!cfg.enabled || !cfg.clientId || !cfg.redirectUri) return res.redirect('/connectors?error=not_configured');

  let userId = null;
  if (action === 'link') {
    userId = getUserIdFromReq(req);
    if (!userId) return res.redirect('/login');
  }

  const state = makeState({ action, userId, provider: 'discord' });
  const params = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    response_type: 'code', scope: 'identify', state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

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
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri,
    });
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const discordUser = await httpsGet('https://discord.com/api/users/@me', `Bearer ${tokenData.access_token}`);
    if (!discordUser.id) throw new Error('Could not get Discord user info');

    const displayName = discordUser.global_name || discordUser.username;

    if (stateData.action === 'link') {
      const conflict = db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').get(discordUser.id, stateData.userId);
      if (conflict) return res.redirect('/connectors?error=already_linked_other&provider=discord');
      db.prepare('UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?').run(discordUser.id, displayName, stateData.userId);
      require('../discordStatus').syncUserRoles(stateData.userId).catch(() => {});
      return res.redirect('/connectors?linked=discord');
    } else {
      const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordUser.id);
      if (!user) return res.redirect('/login?oauth_error=no_account&provider=discord');
      if (user.suspended) return res.redirect('/login?oauth_error=suspended');
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
      return res.redirect('/login?oauth_token=' + encodeURIComponent(token));
    }
  } catch (err) {
    console.error('[connectors] Discord OAuth error:', err.message);
    const dest = stateData.action === 'login' ? '/login' : '/connectors';
    return res.redirect(dest + '?error=' + encodeURIComponent(err.message));
  }
});

router.delete('/discord', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET discord_id = NULL, discord_username = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ── GitHub ────────────────────────────────────────────────────────────────────
router.get('/github/authorize', (req, res) => {
  const action = req.query.action === 'login' ? 'login' : 'link';
  const cfg = getGithubConfig();
  if (!cfg.enabled || !cfg.clientId || !cfg.redirectUri) return res.redirect('/connectors?error=not_configured');

  let userId = null;
  if (action === 'link') {
    userId = getUserIdFromReq(req);
    if (!userId) return res.redirect('/login');
  }

  const state = makeState({ action, userId, provider: 'github' });
  const params = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'read:user', state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/github/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/connectors?error=' + encodeURIComponent(error));
  if (!code || !state) return res.redirect('/connectors?error=missing_params');

  const stateData = consumeState(state);
  if (!stateData) return res.redirect('/connectors?error=invalid_state');

  const cfg = getGithubConfig();
  if (!cfg.clientSecret) return res.redirect('/connectors?error=not_configured');

  try {
    const tokenData = await httpsPost(
      'https://github.com/login/oauth/access_token',
      { client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri },
      { Accept: 'application/json' }
    );
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const githubUser = await httpsGet(
      'https://api.github.com/user',
      `Bearer ${tokenData.access_token}`,
      { 'User-Agent': 'Nodactyl', Accept: 'application/vnd.github+json' }
    );
    if (!githubUser.id) throw new Error('Could not get GitHub user info');

    const displayName = githubUser.name || githubUser.login;
    const githubId = String(githubUser.id);

    if (stateData.action === 'link') {
      const conflict = db.prepare('SELECT id FROM users WHERE github_id = ? AND id != ?').get(githubId, stateData.userId);
      if (conflict) return res.redirect('/connectors?error=already_linked_other&provider=github');
      db.prepare('UPDATE users SET github_id = ?, github_username = ? WHERE id = ?').run(githubId, displayName, stateData.userId);
      return res.redirect('/connectors?linked=github');
    } else {
      const user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);
      if (!user) return res.redirect('/login?oauth_error=no_account&provider=github');
      if (user.suspended) return res.redirect('/login?oauth_error=suspended');
      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
      return res.redirect('/login?oauth_token=' + encodeURIComponent(token));
    }
  } catch (err) {
    console.error('[connectors] GitHub OAuth error:', err.message);
    const dest = stateData.action === 'login' ? '/login' : '/connectors';
    return res.redirect(dest + '?error=' + encodeURIComponent(err.message));
  }
});

router.delete('/github', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET github_id = NULL, github_username = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
