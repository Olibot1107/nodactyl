const { v4: uuidv4 } = require('uuid');

async function sendDiscordWebhook(serverId, status) {
  try {
    const { db } = require('./db');
    const server = db.prepare('SELECT name, discord_webhook, discord_config FROM servers WHERE id = ?').get(serverId);
    if (!server?.discord_webhook) return;

    let cfg = {};
    try { if (server.discord_config) cfg = JSON.parse(server.discord_config); } catch {}

    // Only fire for events the user has enabled
    const events = cfg.events?.length ? cfg.events : ['running', 'stopped', 'error'];
    if (!events.includes(status)) return;

    const colors = { running: 0x22c55e, stopped: 0x6b7280, error: 0xef4444 };
    const labels = { running: '🟢 Online', stopped: '⚫ Offline', error: '🔴 Error' };

    const payload = {
      embeds: [{
        title: server.name,
        description: `Server status changed to **${status}**`,
        color: colors[status] ?? 0x6b7280,
        fields: [{ name: 'Status', value: labels[status] ?? status, inline: true }],
        timestamp: new Date().toISOString(),
        footer: { text: 'Nodactyl' },
      }],
    };

    if (cfg.mention) payload.content = cfg.mention;
    if (cfg.username) payload.username = cfg.username;

    await fetch(server.discord_webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

// Manages all connected daemon WebSocket connections
class NodeManager {
  constructor() {
    this.connections = new Map();   // nodeId → { ws, nodeData }
    this.pending = new Map();       // requestId → { resolve, reject, timer }
    this.logListeners = new Map();  // serverId → Set<socket.io socket>
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  register(nodeId, nodeData, ws) {
    this.connections.set(nodeId, { ws, nodeData });
    ws.on('close', () => this.unregister(nodeId));
    ws.on('message', (raw) => this._handleMessage(nodeId, raw));
  }

  unregister(nodeId) {
    this.connections.delete(nodeId);
    const { db } = require('./db');
    db.prepare(`UPDATE nodes SET status = 'offline' WHERE id = ?`).run(nodeId);
    if (this.io) this.io.emit('node-status', { nodeId, status: 'offline' });
  }

  isOnline(nodeId) {
    return this.connections.has(nodeId);
  }

  // Send a command and wait for its response. Pass { timeout: ms } to override the default 60s.
  send(nodeId, command, { timeout = 60000 } = {}) {
    const conn = this.connections.get(nodeId);
    if (!conn) return Promise.reject(new Error('Node is offline'));

    const requestId = uuidv4();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Command timed out after ${timeout / 1000}s`));
      }, timeout);

      this.pending.set(requestId, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ ...command, requestId }));
    });
  }

  // Fire and forget (log subscriptions etc.)
  emit(nodeId, message) {
    const conn = this.connections.get(nodeId);
    if (conn) conn.ws.send(JSON.stringify(message));
  }

  subscribeToLogs(serverId, socket) {
    if (!this.logListeners.has(serverId)) {
      this.logListeners.set(serverId, new Set());
    }
    this.logListeners.get(serverId).add(socket);

    socket.on('disconnect', () => this.unsubscribeFromLogs(serverId, socket));
  }

  unsubscribeFromLogs(serverId, socket) {
    const subs = this.logListeners.get(serverId);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) this.logListeners.delete(serverId);
    }
  }

  _handleMessage(nodeId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { db } = require('./db');

    switch (msg.type) {
      case 'response': {
        const pending = this.pending.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.requestId);
          if (msg.success) pending.resolve(msg.data || {});
          else pending.reject(new Error(msg.error || 'Command failed'));
        }
        break;
      }

      case 'log': {
        const subs = this.logListeners.get(msg.serverId);
        if (subs) subs.forEach(s => s.emit('log', { serverId: msg.serverId, line: msg.line }));
        break;
      }

      case 'stats': {
        // Scoped emit: only send stats to the server's owner and admins
        if (this.io && msg.serverId) {
          const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(msg.serverId);
          if (srv) this.io.to(`user:${srv.owner_id}`).to('admins').emit('stats', msg);
        }
        break;
      }

      case 'server-status': {
        // Guard: only accept status updates for servers that belong to this node
        const server = db.prepare('SELECT node_id, owner_id FROM servers WHERE id = ?').get(msg.serverId);
        if (!server || server.node_id !== nodeId) break;

        if (msg.status === 'running') {
          // Update container_id first so subscribe-logs (triggered by the Socket.IO emit below)
          // reads the correct container ID from DB — avoids "no such container" on log subscription.
          if (msg.containerId) {
            db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(msg.containerId, msg.serverId);
          }
          db.prepare(`UPDATE servers SET status = ?, started_at = strftime('%s','now') WHERE id = ?`).run(msg.status, msg.serverId);
        } else if (msg.status === 'stopped' || msg.status === 'error') {
          db.prepare(`UPDATE servers SET status = ?, started_at = NULL, terminal_mode = 0 WHERE id = ?`).run(msg.status, msg.serverId);
        } else {
          db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run(msg.status, msg.serverId);
        }
        // Scoped emit: only the server owner and admins receive the update
        if (this.io) {
          this.io.to(`user:${server.owner_id}`).to('admins').emit('server-status', { serverId: msg.serverId, status: msg.status });
          // Also notify members who have console access
          const members = db.prepare("SELECT user_id FROM server_members WHERE server_id = ? AND permissions LIKE '%console%'").all(msg.serverId);
          members.forEach(m => { if (this.io) this.io.to(`user:${m.user_id}`).emit('server-status', { serverId: msg.serverId, status: msg.status }); });
        }
        sendDiscordWebhook(msg.serverId, msg.status);
        break;
      }

      case 'heartbeat': {
        db.prepare(`UPDATE nodes SET status = 'online', last_seen = strftime('%s','now') WHERE id = ?`).run(nodeId);
        if (this.io) this.io.emit('node-status', { nodeId, status: 'online' });
        break;
      }
    }
  }
}

module.exports = new NodeManager();
