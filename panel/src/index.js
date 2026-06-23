const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

let _words = null;
function getWords() {
  if (!_words) {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'words.txt'), 'utf8');
    _words = raw.split('\n').map(w => w.trim()).filter(w => /^[a-z]+$/i.test(w));
  }
  return _words;
}

const { JWT_SECRET, requireAuth } = require('./middleware/auth');
const nodeManager = require('./nodeManager');

function socketCanConsole(server, user) {
  if (user.role === 'admin' || server.owner_id === user.id) return true;
  const { db } = require('./db');
  const member = db.prepare('SELECT permissions FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, user.id);
  if (!member) return false;
  try { return JSON.parse(member.permissions).includes('console'); } catch { return false; }
}

async function main() {
  // Init DB first (sql.js needs async WASM load)
  const { db, init } = require('./db');
  await init();

  const authRoutes = require('./routes/auth');
  const nodeRoutes = require('./routes/nodes');
  const serverRoutes = require('./routes/servers');
  const userRoutes = require('./routes/users');
  const presetRoutes = require('./routes/presets');
  const templateRoutes = require('./routes/templates');
  const connectorRoutes = require('./routes/connectors');
  const rankRoutes = require('./routes/ranks');
  const settingsRoutes = require('./routes/settings');
  const auditRoutes = require('./routes/audit');
  const passkeyRoutes = require('./routes/passkey');
  const totpRoutes = require('./routes/totp');
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIO(httpServer);
  const PORT = process.env.PORT || 3000;

  nodeManager.setIO(io);

  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — panel uses inline scripts; enable & configure once ready
  app.use(express.json({ limit: '99mb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/auth', authRoutes);
  app.use('/api/nodes', nodeRoutes);
  app.use('/api/servers', serverRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/presets', presetRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/connectors', connectorRoutes);
  app.use('/api/ranks', rankRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/passkey', passkeyRoutes);
  app.use('/api/totp', totpRoutes);

  app.get('/api/random-name', requireAuth, (req, res) => {
    const words = getWords();
    const pick = () => words[Math.floor(Math.random() * words.length)].toLowerCase();
    const count = Math.min(Math.max(parseInt(req.query.count) || 1, 1), 50);
    const names = Array.from({ length: count }, () => `${pick()}-${pick()}`);
    res.json(count === 1 ? { name: names[0] } : { names });
  });

  const pub = (f) => path.join(__dirname, '..', 'public', f);
  app.get('/', (req, res) => res.redirect('/login'));
  app.get('/login', (req, res) => res.sendFile(pub('login.html')));
  app.get('/register', (req, res) => res.sendFile(pub('register.html')));
  app.get('/dashboard', (req, res) => res.sendFile(pub('dashboard.html')));
  app.get('/nodes', (req, res) => res.sendFile(pub('nodes.html')));
  app.get('/server/:id', (req, res) => res.sendFile(pub('server.html')));
  app.get('/server/:id/files', (req, res) => res.sendFile(pub('files.html')));
  app.get('/server/:id/settings', (req, res) => res.sendFile(pub('server-settings.html')));
  app.get('/server/:id/packages', (req, res) => res.sendFile(pub('packages.html')));
  app.get('/server/:id/activity', (req, res) => res.sendFile(pub('server-activity.html')));
  app.get('/account', (req, res) => res.sendFile(pub('account.html')));
  app.get('/connectors', (req, res) => res.sendFile(pub('connectors.html')));
  app.get('/admin/users', (req, res) => res.sendFile(pub('admin/users.html')));
  app.get('/admin/presets', (req, res) => res.sendFile(pub('admin/presets.html')));
  app.get('/admin/templates',   (req, res) => res.sendFile(pub('admin/templates.html')));
  app.get('/admin/connectors', (req, res) => res.sendFile(pub('admin/connectors.html')));
  app.get('/admin/servers', (req, res) => res.sendFile(pub('admin/servers.html')));
  app.get('/admin/ranks', (req, res) => res.sendFile(pub('admin/ranks.html')));
  app.get('/admin/settings', (req, res) => res.sendFile(pub('admin/settings.html')));
  app.get('/admin/audit',          (req, res) => res.sendFile(pub('admin/audit.html')));
  app.get('/logs/:shareId', (req, res) => res.sendFile(pub('log-viewer.html')));

  // ── Favicon ───────────────────────────────────────────────────────────────────
  function getFaviconSvg() {
    const { db } = require('./db');
    const logo = db.prepare("SELECT value FROM settings WHERE key = 'panel_logo'").get()?.value || 'N';
    if (logo.startsWith('http') || logo.startsWith('/')) return { redirect: logo };
    if (logo.startsWith('data:')) {
      const safe = logo.replace(/"/g, '&quot;');
      return { svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><image href="${safe}" width="32" height="32"/></svg>` };
    }
    const safe = logo.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f97316"/><text x="16" y="23" font-family="system-ui,sans-serif" font-size="18" font-weight="800" text-anchor="middle" fill="#fff">${safe}</text></svg>` };
  }

  app.get('/favicon.svg', (req, res) => {
    const result = getFaviconSvg();
    if (result.redirect) return res.redirect(result.redirect);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(result.svg);
  });

  app.get('/favicon.ico', (req, res) => {
    const result = getFaviconSvg();
    if (result.redirect) return res.redirect(result.redirect);
    res.redirect('/favicon.svg');
  });

  // Redact lines in a log share (requires auth + sharelog permission on that server)
  app.patch('/api/log-shares/:shareId', requireAuth, (req, res) => {
    const share = db.prepare('SELECT * FROM log_shares WHERE id = ?').get(req.params.shareId);
    if (!share) return res.status(404).json({ error: 'Not found' });
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(share.server_id);
    if (!server) return res.status(404).json({ error: 'Not found' });
    const user = req.user;
    let allowed = user.role === 'admin' || server.owner_id === user.id;
    if (!allowed) {
      const member = db.prepare('SELECT permissions FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, user.id);
      try { allowed = JSON.parse(member?.permissions || '[]').includes('sharelog'); } catch {}
    }
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    if (Buffer.byteLength(content) > 512 * 1024) return res.status(400).json({ error: 'Content too large' });
    db.prepare('UPDATE log_shares SET content = ? WHERE id = ?').run(content, req.params.shareId);
    res.json({ ok: true });
  });

  // Public log share read (no auth)
  app.get('/api/log-shares/:shareId', (req, res) => {
    const { db } = require('./db');
    const now = Math.floor(Date.now() / 1000);
    const share = db.prepare('SELECT id, label, content, view_count, created_at, expires_at FROM log_shares WHERE id = ? AND expires_at > ?').get(req.params.shareId, now);
    if (!share) return res.status(404).json({ error: 'Log share not found or expired' });
    db.prepare('UPDATE log_shares SET view_count = view_count + 1 WHERE id = ?').run(req.params.shareId);
    res.json({ ...share, view_count: share.view_count + 1 });
  });

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
      if (!socketCanConsole(server, socket.user)) return socket.emit('error', 'Forbidden');
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
      if (!socketCanConsole(server, socket.user)) return;
      nodeManager.emit(server.node_id, { type: 'exec', serverId, containerId: server.container_id, command });
    });
  });

  // Background job: auto-delete servers with no files after 24h (checks every 30 min)
  setInterval(async () => {
    try {
      const checkable = db.prepare(`SELECT * FROM servers WHERE status NOT IN ('installing')`).all();
      const now = Math.floor(Date.now() / 1000);
      for (const server of checkable) {
        if (!nodeManager.isOnline(server.node_id) || !server.container_id) continue;
        try {
          const result = await nodeManager.send(server.node_id, {
            type: 'list-files', serverId: server.id, containerId: server.container_id, path: '/',
          }, { timeout: 10000 });
          const files = result?.files || [];
          const hasFiles = Array.isArray(files) && files.length > 0;
          if (hasFiles) {
            if (server.no_files_since) {
              db.prepare('UPDATE servers SET no_files_since = NULL WHERE id = ?').run(server.id);
              io.to(`user:${server.owner_id}`).emit('no-files-changed', { serverId: server.id, no_files_since: null });
            }
          } else if (!server.no_files_since) {
            db.prepare('UPDATE servers SET no_files_since = ? WHERE id = ?').run(now, server.id);
            io.to(`user:${server.owner_id}`).emit('no-files-changed', { serverId: server.id, no_files_since: now });
          } else if (now - server.no_files_since >= 24 * 3600) {
            console.log(`[cleanup] Auto-deleting server ${server.id.slice(0, 8)} — no files for 24h`);
            nodeManager.send(server.node_id, {
              type: 'delete-server', serverId: server.id, containerId: server.container_id,
            }, { timeout: 30000 }).catch(() => {});
            db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
            io.to(`user:${server.owner_id}`).to('admins').emit('server-deleted', { serverId: server.id });
          }
        } catch {}
      }
    } catch {}
  }, 30 * 60 * 1000);

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
