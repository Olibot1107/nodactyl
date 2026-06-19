const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const path = require('path');
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = require('./middleware/auth');
const nodeManager = require('./nodeManager');

async function main() {
  // Init DB first (sql.js needs async WASM load)
  const { db, init } = require('./db');
  await init();

  const authRoutes = require('./routes/auth');
  const nodeRoutes = require('./routes/nodes');
  const serverRoutes = require('./routes/servers');

  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIO(httpServer);
  const PORT = process.env.PORT || 3000;

  nodeManager.setIO(io);

  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/auth', authRoutes);
  app.use('/api/nodes', nodeRoutes);
  app.use('/api/servers', serverRoutes);

  app.get('/', (req, res) => res.redirect('/login'));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
  app.get('/nodes', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'nodes.html')));
  app.get('/server/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'server.html')));

  // ── Daemon WebSocket endpoint ────────────────────────────────────────────────
  const daemonWss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/daemon') {
      daemonWss.handleUpgrade(req, socket, head, ws => daemonWss.emit('connection', ws, req));
    }
    // socket.io handles /socket.io/ upgrades itself
  });

  daemonWss.on('connection', (ws) => {
    let authenticated = false;
    let nodeId = null;

    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Auth timeout');
    }, 10000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (!authenticated) {
        if (msg.type !== 'auth') return ws.close(4001, 'Expected auth message');

        const node = db.prepare('SELECT * FROM nodes WHERE token = ?').get(msg.token);
        if (!node) {
          ws.send(JSON.stringify({ type: 'auth-result', success: false, error: 'Invalid token' }));
          return ws.close(4001, 'Bad token');
        }

        clearTimeout(authTimer);
        authenticated = true;
        nodeId = node.id;

        db.prepare(`UPDATE nodes SET status = 'online', last_seen = strftime('%s','now') WHERE id = ?`).run(nodeId);
        nodeManager.register(nodeId, node, ws);
        io.emit('node-status', { nodeId, status: 'online' });

        ws.send(JSON.stringify({ type: 'auth-result', success: true, nodeId: node.id, name: node.name }));
        console.log(`[daemon] Node "${node.name}" connected`);
        return;
      }
      // Authenticated messages handled by nodeManager via ws.on('message')
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (nodeId) console.log(`[daemon] Node ${nodeId} disconnected`);
    });
  });

  // ── Browser Socket.IO ────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token
      || socket.handshake.headers.cookie?.match(/token=([^;]+)/)?.[1];
    if (!token) return next(new Error('Unauthorized'));
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('subscribe-logs', ({ serverId }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) return socket.emit('error', 'Server not found');
      if (server.owner_id !== socket.user.id && socket.user.role !== 'admin') return socket.emit('error', 'Forbidden');
      if (!nodeManager.isOnline(server.node_id)) return socket.emit('log', { serverId, line: '[Node is offline]\n' });

      nodeManager.subscribeToLogs(serverId, socket);
      nodeManager.emit(server.node_id, { type: 'subscribe-logs', serverId, containerId: server.container_id });
    });

    socket.on('unsubscribe-logs', ({ serverId }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (server) nodeManager.emit(server.node_id, { type: 'unsubscribe-logs', serverId });
      nodeManager.unsubscribeFromLogs(serverId, socket);
    });

    socket.on('send-command', ({ serverId, command }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) return;
      if (server.owner_id !== socket.user.id && socket.user.role !== 'admin') return;
      nodeManager.emit(server.node_id, { type: 'exec', serverId, containerId: server.container_id, command });
    });
  });

  httpServer.listen(PORT, () => {
    console.log(`\n  Nodactyl Panel  →  http://localhost:${PORT}`);
    console.log(`  Daemon endpoint →  ws://localhost:${PORT}/daemon\n`);
  });
}

main().catch(err => { console.error('Startup error:', err); process.exit(1); });
