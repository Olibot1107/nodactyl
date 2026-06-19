const { v4: uuidv4 } = require('uuid');

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

  // Send a command and wait for its response
  send(nodeId, command) {
    const conn = this.connections.get(nodeId);
    if (!conn) return Promise.reject(new Error('Node is offline'));

    const requestId = uuidv4();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Command timed out after 60s'));
      }, 60000);

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
        if (this.io) this.io.emit('stats', msg);
        break;
      }

      case 'server-status': {
        db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run(msg.status, msg.serverId);
        if (this.io) this.io.emit('server-status', { serverId: msg.serverId, status: msg.status });
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
