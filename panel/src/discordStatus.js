const DISCORD_API = 'https://discord.com/api/v10';
const DEFAULT_INTERVAL_SECS = 60;

function getSetting(key) {
  const { db } = require('./db');
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null;
}

function setSetting(key, value) {
  const { db } = require('./db');
  if (value == null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
}

async function discordFetch(url, options, retries = 3) {
  const res = await fetch(url, options);
  if (res.status === 429 && retries > 0) {
    let wait = 1000;
    try {
      const body = await res.clone().json();
      wait = Math.ceil((body.retry_after ?? 1) * 1000) + 100;
    } catch {}
    await new Promise(r => setTimeout(r, wait));
    return discordFetch(url, options, retries - 1);
  }
  return res;
}


function formatUptime(seconds) {
  if (seconds == null || seconds < 0) return 'N/A';
  seconds = Math.floor(seconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s} second${s !== 1 ? 's' : ''}`;
}

function formatMb(mb) {
  if (!mb || mb <= 0) return '0 B';
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function buildStatsPayload() {
  const { db } = require('./db');
  const nodeManager = require('./nodeManager');

  const nodes = db.prepare('SELECT * FROM nodes ORDER BY name ASC').all();
  const totalServers = db.prepare('SELECT COUNT(*) as n FROM servers').get()?.n ?? 0;
  const totalUsers = db.prepare('SELECT COUNT(*) as n FROM users').get()?.n ?? 0;
  const onlineCount = nodes.filter(n => nodeManager.isOnline(n.id)).length;
  const panelName = getSetting('panel_name') || 'Nodactyl';
  const intervalSecs = Math.max(30, parseInt(getSetting('discord_stats_interval')) || DEFAULT_INTERVAL_SECS);
  const nextTs = Math.floor(Date.now() / 1000) + intervalSecs;

  let desc = `Next update <t:${nextTs}:R>\n\n`;
  desc += `**Panel — 🟢 Online**\n`;
  desc += '```\n';
  desc += `${pad('Nodes', 8)}: ${onlineCount} / ${nodes.length}\n`;
  desc += `${pad('Servers', 8)}: ${totalServers}\n`;
  desc += `${pad('Users', 8)}: ${totalUsers}\n`;
  desc += `${pad('Uptime', 8)}: ${formatUptime(Math.floor(process.uptime()))}\n`;
  desc += '```';

  if (nodes.length > 0) {
    desc += '\n**Nodes Stats**';
    for (const node of nodes) {
      const online = nodeManager.isOnline(node.id);
      const serverCount = db.prepare('SELECT COUNT(*) as n FROM servers WHERE node_id = ?').get(node.id)?.n ?? 0;

      desc += `\n\n**${node.name} — ${online ? '🟢 Online' : '🔴 Offline'}**\n`;
      desc += '```\n';

      if (online) {
        const allocMem = db.prepare('SELECT COALESCE(SUM(memory_limit),0) as s FROM servers WHERE node_id = ?').get(node.id)?.s ?? 0;
        const allocDisk = db.prepare('SELECT COALESCE(SUM(disk_limit),0) as s FROM servers WHERE node_id = ? AND disk_limit > 0').get(node.id)?.s ?? 0;
        const connectedAt = nodeManager.getConnectedAt(node.id);
        const uptime = connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : null;

        desc += `${pad('Memory', 8)}: ${formatMb(allocMem)} / ${node.memory > 0 ? formatMb(node.memory) : 'Unlimited'}\n`;
        desc += `${pad('Disk', 8)}: ${formatMb(allocDisk)} / ${node.disk_limit > 0 ? formatMb(node.disk_limit) : 'Unlimited'}\n`;
        desc += `${pad('Servers', 8)}: ${serverCount}\n`;
        desc += `${pad('Uptime', 8)}: ${formatUptime(uptime)}\n`;
      } else {
        desc += `${pad('Memory', 8)}: N/A\n`;
        desc += `${pad('Disk', 8)}: N/A\n`;
        desc += `${pad('Servers', 8)}: ${serverCount}\n`;
        desc += `${pad('Uptime', 8)}: N/A\n`;
      }

      desc += '```';
    }
  }

  return {
    embeds: [{
      author: { name: panelName },
      description: desc,
      color: 0x5865f2,
      timestamp: new Date().toISOString(),
      footer: { text: 'Nodactyl' },
    }],
  };
}

async function updateStatusMessage() {
  try {
    const token = getSetting('discord_status_token');
    const channelId = getSetting('discord_stats_channel_id');
    if (!token || !channelId || getSetting('discord_stats_enabled') !== '1') return;

    const payload = buildStatsPayload();
    const messageId = getSetting('discord_stats_message_id');

    if (messageId) {
      const res = await discordFetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 404 || res.status === 400) {
        // Message was deleted from Discord — clear ID and create fresh
        setSetting('discord_stats_message_id', null);
        await _createStatusMessage(token, channelId, payload);
      }
    } else {
      await _createStatusMessage(token, channelId, payload);
    }
  } catch (err) {
    console.error('[discord-status] stats update failed:', err.message);
  }
}

async function _createStatusMessage(token, channelId, payload) {
  const res = await discordFetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    const msg = await res.json();
    setSetting('discord_stats_message_id', msg.id);
  }
}

async function syncUserRoles(panelUserId) {
  try {
    const token = getSetting('discord_status_token');
    const guildId = getSetting('discord_roles_guild_id') || getSetting('discord_stats_guild_id');
    if (!token || !guildId) return;

    const { db } = require('./db');
    const user = db.prepare('SELECT discord_id, rank_id FROM users WHERE id = ?').get(panelUserId);
    if (!user?.discord_id) return;

    const rankRoles = JSON.parse(getSetting('discord_rank_roles') || '{}');
    const linkedRole = getSetting('discord_linked_role') || null;

    // All role IDs this system manages
    const managedRoles = new Set([
      ...Object.values(rankRoles).filter(Boolean),
      ...(linkedRole ? [linkedRole] : []),
    ]);

    // Roles this user should have
    const targetRoles = new Set();
    if (linkedRole) targetRoles.add(linkedRole);
    if (user.rank_id && rankRoles[user.rank_id]) targetRoles.add(rankRoles[user.rank_id]);

    // Fetch current guild member roles
    const memberRes = await discordFetch(`${DISCORD_API}/guilds/${guildId}/members/${user.discord_id}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!memberRes.ok) return;
    const member = await memberRes.json();
    const currentRoles = new Set(member.roles || []);

    for (const roleId of targetRoles) {
      if (!currentRoles.has(roleId)) {
        await discordFetch(`${DISCORD_API}/guilds/${guildId}/members/${user.discord_id}/roles/${roleId}`, {
          method: 'PUT',
          headers: { Authorization: `Bot ${token}` },
        });
        await new Promise(r => setTimeout(r, 500));
      }
    }

    for (const roleId of managedRoles) {
      if (!targetRoles.has(roleId) && currentRoles.has(roleId)) {
        await discordFetch(`${DISCORD_API}/guilds/${guildId}/members/${user.discord_id}/roles/${roleId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${token}` },
        });
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch {}
}

async function syncAllLinkedUsers() {
  const { db } = require('./db');
  const users = db.prepare('SELECT id FROM users WHERE discord_id IS NOT NULL').all();
  for (let i = 0; i < users.length; i++) {
    await syncUserRoles(users[i].id);
    if (i < users.length - 1) await new Promise(r => setTimeout(r, 5000));
  }
}

module.exports = { updateStatusMessage, syncUserRoles, syncAllLinkedUsers, discordFetch, DISCORD_API, getSetting };
