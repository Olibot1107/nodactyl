const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
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
  const userRoutes = require('./routes/users');
  const presetRoutes = require('./routes/presets');
  const rankRoutes = require('./routes/ranks');
  const settingsRoutes = require('./routes/settings');
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIO(httpServer);
  const PORT = process.env.PORT || 3000;

  nodeManager.setIO(io);

  app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — panel uses inline scripts; enable & configure once ready
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/auth', authRoutes);
  app.use('/api/nodes', nodeRoutes);
  app.use('/api/servers', serverRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/presets', presetRoutes);
  app.use('/api/ranks', rankRoutes);
  app.use('/api/settings', settingsRoutes);

  const pub = (f) => path.join(__dirname, '..', 'public', f);
  app.get('/', (req, res) => res.redirect('/login'));
  app.get('/login', (req, res) => res.sendFile(pub('login.html')));
  app.get('/register', (req, res) => res.sendFile(pub('register.html')));
  app.get('/dashboard', (req, res) => res.sendFile(pub('dashboard.html')));
  app.get('/nodes', (req, res) => res.sendFile(pub('nodes.html')));
  app.get('/server/:id', (req, res) => res.sendFile(pub('server.html')));
  app.get('/server/:id/files', (req, res) => res.sendFile(pub('files.html')));
  app.get('/server/:id/settings', (req, res) => res.sendFile(pub('server-settings.html')));
  app.get('/account', (req, res) => res.sendFile(pub('account.html')));
  app.get('/admin/users', (req, res) => res.sendFile(pub('admin/users.html')));
  app.get('/admin/presets', (req, res) => res.sendFile(pub('admin/presets.html')));
  app.get('/admin/servers', (req, res) => res.sendFile(pub('admin/servers.html')));
  app.get('/admin/ranks', (req, res) => res.sendFile(pub('admin/ranks.html')));
  app.get('/admin/settings', (req, res) => res.sendFile(pub('admin/settings.html')));

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
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id, username, role, suspended FROM users WHERE id = ?').get(decoded.id);
      if (!user || user.suspended) return next(new Error('Unauthorized'));
      socket.user = { ...decoded, role: user.role };
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // Join personal room so server-status can be scoped to owner only
    socket.join(`user:${socket.user.id}`);
    if (socket.user.role === 'admin') socket.join('admins');

    socket.on('subscribe-logs', ({ serverId, tail }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) return socket.emit('error', 'Server not found');
      if (server.owner_id !== socket.user.id && socket.user.role !== 'admin') return socket.emit('error', 'Forbidden');
      if (!nodeManager.isOnline(server.node_id)) return socket.emit('log', { serverId, line: '[Node is offline]\n' });

      nodeManager.subscribeToLogs(serverId, socket);
      nodeManager.emit(server.node_id, { type: 'subscribe-logs', serverId, containerId: server.container_id, tail });
    });

    socket.on('unsubscribe-logs', ({ serverId }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (server && (server.owner_id === socket.user.id || socket.user.role === 'admin')) {
        nodeManager.emit(server.node_id, { type: 'unsubscribe-logs', serverId });
      }
      nodeManager.unsubscribeFromLogs(serverId, socket);
    });

    socket.on('send-command', ({ serverId, command }) => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server) return;
      if (server.owner_id !== socket.user.id && socket.user.role !== 'admin') return;
      nodeManager.emit(server.node_id, { type: 'exec', serverId, containerId: server.container_id, command });
    });
  });

  // Background disk limit enforcement — checks all running servers every 60 seconds
  setInterval(async () => {
    try {
      const running = db.prepare(`SELECT * FROM servers WHERE status = 'running' AND disk_limit > 0`).all();
      for (const server of running) {
        if (!nodeManager.isOnline(server.node_id) || !server.container_id) continue;
        try {
          const stats = await nodeManager.send(server.node_id, {
            type: 'get-stats', serverId: server.id, containerId: server.container_id,
          }, { timeout: 10000 });
          if (stats.diskUsed && stats.diskUsed > server.disk_limit * 1024 * 1024) {
            console.log(`[limit] Server ${server.id.slice(0, 8)} disk ${Math.round(stats.diskUsed / 1024 / 1024)} MB > limit ${server.disk_limit} MB — stopping`);
            nodeManager.send(server.node_id, {
              type: 'server-action', serverId: server.id, containerId: server.container_id, action: 'kill',
            }, { timeout: 10000 }).catch(() => {});
          }
        } catch {}
      }
    } catch {}
  }, 60000);

  httpServer.listen(PORT, () => {
    console.log(`\n  Nodactyl Panel  →  http://localhost:${PORT}`);
    console.log(`  Daemon endpoint →  ws://localhost:${PORT}/daemon\n`);
  });
}

main().catch(err => { console.error('Startup error:', err); process.exit(1); });
