const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { updateStatusMessage, syncAllLinkedUsers, DISCORD_API, getSetting, discordFetch } = require('../discordStatus');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function setSetting(key, value) {
  if (value === null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
}

async function discordGet(path, token) {
  const res = await discordFetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Discord API error ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// GET — current config (token never returned)
router.get('/', (req, res) => {
  res.json({
    hasToken: !!getSetting('discord_status_token'),
    statsGuildId: getSetting('discord_stats_guild_id'),
    statsGuildName: getSetting('discord_stats_guild_name'),
    statsChannelId: getSetting('discord_stats_channel_id'),
    statsChannelName: getSetting('discord_stats_channel_name'),
    messageId: getSetting('discord_stats_message_id'),
    statsEnabled: getSetting('discord_stats_enabled') === '1',
    interval: parseInt(getSetting('discord_stats_interval')) || 60,
  });
});

// GET /bot — live bot info from Discord API
router.get('/bot', async (req, res) => {
  const token = getSetting('discord_status_token');
  if (!token) return res.json({ online: false });
  try {
    const me = await discordGet('/users/@me', token);
    const avatarUrl = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(me.id) >> 22n) % 6n}.png`;
    res.json({
      online: true,
      id: me.id,
      username: me.username,
      discriminator: me.discriminator,
      avatarUrl,
    });
  } catch {
    res.json({ online: false });
  }
});

// POST /token — validate + save bot token
router.post('/token', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Token is required' });
  }
  const t = token.trim();
  try {
    const me = await discordGet('/users/@me', t);
    if (!me.id) throw new Error('Unexpected bot response');
    setSetting('discord_status_token', t);
    // Clear stats config on token change so stale guild/channel is not used
    ['discord_stats_guild_id', 'discord_stats_guild_name', 'discord_stats_channel_id', 'discord_stats_channel_name', 'discord_stats_message_id']
      .forEach(k => setSetting(k, null));
    res.json({ ok: true, botName: me.username + '#' + me.discriminator });
  } catch (err) {
    res.status(400).json({ error: 'Could not connect: ' + err.message });
  }
});

// DELETE /token — remove all discord status config
router.delete('/token', (req, res) => {
  ['discord_status_token', 'discord_stats_guild_id', 'discord_stats_guild_name', 'discord_stats_channel_id', 'discord_stats_channel_name', 'discord_stats_message_id']
    .forEach(k => setSetting(k, null));
  res.json({ ok: true });
});

// GET /guilds — guilds the bot is in
router.get('/guilds', async (req, res) => {
  const token = getSetting('discord_status_token');
  if (!token) return res.status(400).json({ error: 'No bot token configured' });
  try {
    const guilds = await discordGet('/users/@me/guilds', token);
    res.json(guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /guilds/:guildId/channels — text channels for a guild
router.get('/guilds/:guildId/channels', async (req, res) => {
  const token = getSetting('discord_status_token');
  if (!token) return res.status(400).json({ error: 'No bot token configured' });
  try {
    const channels = await discordGet(`/guilds/${req.params.guildId}/channels`, token);
    // 0 = text, 5 = announcement — both support message sending
    const text = channels
      .filter(c => c.type === 0 || c.type === 5)
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /stats-channel — save the guild + channel (and optional interval) for the stats message
router.patch('/stats-channel', async (req, res) => {
  const { guildId, guildName, channelId, channelName, interval } = req.body;
  if (!guildId || !channelId) return res.status(400).json({ error: 'guildId and channelId are required' });
  // Clear saved message ID when channel changes so a fresh message is created
  const existing = getSetting('discord_stats_channel_id');
  if (existing !== channelId) setSetting('discord_stats_message_id', null);
  setSetting('discord_stats_guild_id', guildId);
  setSetting('discord_stats_guild_name', guildName || guildId);
  setSetting('discord_stats_channel_id', channelId);
  setSetting('discord_stats_channel_name', channelName || channelId);
  if (interval !== undefined) {
    const secs = Math.max(30, parseInt(interval) || 60);
    setSetting('discord_stats_interval', String(secs));
  }
  setSetting('discord_stats_enabled', '1');
  // Post immediately on save
  try { await updateStatusMessage(); } catch {}
  res.json({ ok: true, messageId: getSetting('discord_stats_message_id') });
});


// DELETE /stats-message — disable auto-updates and clear saved message ID
router.delete('/stats-message', (req, res) => {
  setSetting('discord_stats_enabled', '0');
  setSetting('discord_stats_message_id', null);
  res.json({ ok: true });
});

// GET /guild-roles — list roles in the configured guild (for the role sync UI)
router.get('/guild-roles', async (req, res) => {
  const token = getSetting('discord_status_token');
  const guildId = getSetting('discord_stats_guild_id');
  if (!token || !guildId) return res.status(400).json({ error: 'Bot token and guild must be configured first' });
  try {
    const roles = await discordGet(`/guilds/${guildId}/roles`, token);
    res.json(
      roles
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.color }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /rank-roles — get current rank→role mappings + linked role
router.get('/rank-roles', (req, res) => {
  res.json({
    rankRoles: JSON.parse(getSetting('discord_rank_roles') || '{}'),
    linkedRole: getSetting('discord_linked_role') || null,
  });
});

// PATCH /rank-roles — save rank→role mappings + linked role
router.patch('/rank-roles', (req, res) => {
  const { rankRoles, linkedRole } = req.body;
  if (rankRoles && typeof rankRoles === 'object') {
    setSetting('discord_rank_roles', JSON.stringify(rankRoles));
  }
  setSetting('discord_linked_role', linkedRole || null);
  res.json({ ok: true });
});

// POST /sync-roles — push roles to all linked users now
router.post('/sync-roles', async (req, res) => {
  const token = getSetting('discord_status_token');
  const guildId = getSetting('discord_stats_guild_id');
  if (!token || !guildId) return res.status(400).json({ error: 'Bot token and guild must be configured first' });
  try {
    await syncAllLinkedUsers();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
