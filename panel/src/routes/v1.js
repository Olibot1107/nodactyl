const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireApiKey } = require('../middleware/apikey');
const { apiRateLimit } = require('../middleware/apiRateLimit');
const nodeManager = require('../nodeManager');
const { audit } = require('../audit');

const router = express.Router();
router.use(requireApiKey);
router.use(apiRateLimit);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getServer(id) {
  return db.prepare(`
    SELECT s.*, n.name as node_name, n.ip_address as node_ip_address
    FROM servers s JOIN nodes n ON s.node_id = n.id
    WHERE s.id = ? AND s.status != 'deleting'
  `).get(id);
}

function canAccess(server, user) {
  if (user.role === 'admin' || server.owner_id === user.id) return true;
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, user.id);
}

function hasPerm(server, user, perm) {
  if (user.role === 'admin' || server.owner_id === user.id) return true;
  const m = db.prepare('SELECT permissions FROM server_members WHERE server_id = ? AND user_id = ?').get(server.id, user.id);
  if (!m) return false;
  try { return JSON.parse(m.permissions).includes(perm); } catch { return false; }
}

function sendFileError(res, err) {
  const msg = err.message || 'File operation failed';
  if (/no such file|not found/i.test(msg)) return res.status(404).json({ error: msg });
  if (/is a directory|cannot read a directory/i.test(msg)) return res.status(400).json({ error: msg });
  return res.status(500).json({ error: msg });
}

function fileMsg(server, extra) {
  return { serverId: server.id, containerId: server.container_id, ...extra };
}

function formatServer(s) {
  return {
    ...s,
    port_mappings: JSON.parse(s.port_mappings || '[]'),
    env_vars: JSON.parse(s.env_vars || '[]'),
    node_online: nodeManager.isOnline(s.node_id),
  };
}

function checkFileAccess(server, user, res) {
  if (!hasPerm(server, user, 'files')) { res.status(403).json({ error: 'Forbidden' }); return false; }
  if (server.suspended && user.role !== 'admin') { res.status(403).json({ error: 'Server is suspended' }); return false; }
  if (!nodeManager.isOnline(server.node_id)) { res.status(503).json({ error: 'Node is offline' }); return false; }
  return true;
}

// ── Node / quota helpers (mirrored from servers.js) ──────────────────────────

function getUsedPorts(nodeId) {
  const rows = db.prepare('SELECT port_mappings FROM servers WHERE node_id = ?').all(nodeId);
  const used = new Set();
  for (const row of rows) {
    try { for (const m of JSON.parse(row.port_mappings)) { if (m.hostPort) used.add(Number(m.hostPort)); } } catch {}
  }
  return used;
}

function findAvailablePort(nodeId) {
  const node = db.prepare('SELECT port_range_start, port_range_end FROM nodes WHERE id = ?').get(nodeId);
  const rangeStart = node?.port_range_start ?? 10000;
  const rangeEnd   = node?.port_range_end   ?? 30000;
  const used = getUsedPorts(nodeId);
  for (let p = rangeStart; p <= rangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

function autoPortMappings(nodeId) {
  const hostPort = findAvailablePort(nodeId);
  if (!hostPort) return [];
  return [
    { hostPort, containerPort: hostPort, protocol: 'tcp' },
    { hostPort, containerPort: hostPort, protocol: 'udp' },
  ];
}

function checkNodeCapacity(nodeId, addMemoryMb, addDiskMb) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return 'Node not found';
  if (node.memory > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as used FROM servers WHERE node_id = ?').get(nodeId)?.used ?? 0;
    if (addMemoryMb > node.memory - used) return `Not enough memory on this node (${Math.max(0, node.memory - used)} MB free)`;
  }
  if (node.disk_limit > 0 && addDiskMb > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(disk_limit), 0) as used FROM servers WHERE node_id = ? AND disk_limit > 0').get(nodeId)?.used ?? 0;
    if (addDiskMb > node.disk_limit - used) return `Not enough disk on this node (${Math.max(0, node.disk_limit - used)} MB free)`;
  }
  return null;
}

function findAvailableNode(preferNodeId, memoryMb, diskMb) {
  const online = db.prepare('SELECT * FROM nodes').all().filter(n => nodeManager.isOnline(n.id));
  if (preferNodeId) {
    const pref = online.find(n => n.id === preferNodeId);
    if (pref && !checkNodeCapacity(pref.id, memoryMb, diskMb)) return pref.id;
  }
  const candidates = online
    .filter(n => n.id !== preferNodeId)
    .map(n => {
      const used = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as u FROM servers WHERE node_id = ?').get(n.id)?.u ?? 0;
      return { id: n.id, free: n.memory - used };
    })
    .sort((a, b) => b.free - a.free);
  for (const n of candidates) {
    if (!checkNodeCapacity(n.id, memoryMb, diskMb)) return n.id;
  }
  return null;
}

function checkAccountLimits(userId, addMemoryMb, addDiskMb) {
  const data = db.prepare(`
    SELECT u.role, r.max_servers, r.memory_limit, r.disk_limit
    FROM users u LEFT JOIN ranks r ON u.rank_id = r.id WHERE u.id = ?
  `).get(userId);
  if (!data || data.role === 'admin') return null;
  const maxServers = data.max_servers ?? 1;
  if (maxServers !== -1) {
    const count = db.prepare('SELECT COUNT(*) as n FROM servers WHERE owner_id = ?').get(userId)?.n ?? 0;
    if (count >= maxServers) return `Server limit reached (${count}/${maxServers}). Ask an admin to upgrade your rank.`;
  }
  if (data.memory_limit > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as u FROM servers WHERE owner_id = ?').get(userId)?.u ?? 0;
    if (used + addMemoryMb > data.memory_limit) return `Memory quota exceeded (${data.memory_limit - used} MB remaining).`;
  }
  if (data.disk_limit > 0 && addDiskMb > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(disk_limit), 0) as u FROM servers WHERE owner_id = ? AND disk_limit > 0').get(userId)?.u ?? 0;
    if (used + addDiskMb > data.disk_limit) return `Disk quota exceeded (${data.disk_limit - used} MB remaining).`;
  }
  return null;
}

function checkRankAccess(userId, requiredRankId) {
  if (!requiredRankId) return true;
  const u = db.prepare('SELECT rank_id FROM users WHERE id = ?').get(userId);
  if (!u?.rank_id) return false;
  const uRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(u.rank_id);
  const rRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(requiredRankId);
  return uRank && rRank && uRank.sort_order >= rRank.sort_order;
}

function validateGitUrl(url, res) {
  if (!/^https:\/\/.+/.test(url)) { res.status(400).json({ error: 'Only https:// URLs are supported' }); return false; }
  try {
    const p = new URL(url);
    if (/^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fd[0-9a-f]{2}:)/i.test(p.hostname) || /^\d+$/.test(p.hostname)) {
      res.status(400).json({ error: 'Private or loopback URLs are not allowed' }); return false;
    }
  } catch { res.status(400).json({ error: 'Invalid URL' }); return false; }
  return true;
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

// GET /api/v1/nodes
router.get('/nodes', (req, res) => {
  const nodes = db.prepare('SELECT id, name, description, memory, cpu, disk_limit, port_range_start, port_range_end, ip_address, status FROM nodes ORDER BY name ASC').all();
  res.json(nodes.map(n => ({ ...n, online: nodeManager.isOnline(n.id) })));
});

// ── Servers ───────────────────────────────────────────────────────────────────

// GET /api/v1/servers
router.get('/servers', (req, res) => {
  const servers = req.user.role === 'admin'
    ? db.prepare("SELECT s.*, n.name as node_name, n.ip_address as node_ip_address FROM servers s JOIN nodes n ON s.node_id = n.id WHERE s.status != 'deleting' ORDER BY s.created_at DESC").all()
    : db.prepare(`SELECT s.*, n.name as node_name, n.ip_address as node_ip_address
        FROM servers s JOIN nodes n ON s.node_id = n.id
        WHERE s.status != 'deleting' AND (s.owner_id = ? OR s.id IN (SELECT server_id FROM server_members WHERE user_id = ?))
        ORDER BY s.created_at DESC`).all(req.user.id, req.user.id);
  res.json(servers.map(formatServer));
});

// GET /api/v1/servers/:id
router.get('/servers/:id', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json(formatServer(server));
});

// GET /api/v1/servers/:id/stats
router.get('/servers/:id/stats', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'console')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.json({ cpu: 0, memory: 0, status: 'node_offline' });
  if (!server.container_id || server.status !== 'running') return res.json({ cpu: 0, memory: 0, status: server.status });
  try {
    const stats = await nodeManager.send(server.node_id, { type: 'get-stats', serverId: server.id, containerId: server.container_id });
    res.json({ ...stats, diskLimit: server.disk_limit || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/servers/:id/action  { action: "start"|"stop"|"restart"|"kill" }
router.post('/servers/:id/action', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'power')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });

  const { action } = req.body;
  const validActions = ['start', 'stop', 'restart', 'kill'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action. Valid: ' + validActions.join(', ') });
  if (server.status === 'installing') return res.status(400).json({ error: 'Server is still installing' });
  if (action === 'start' && server.suspended) return res.status(403).json({ error: 'Server is suspended' });

  const msg = { type: 'server-action', serverId: server.id, containerId: server.container_id, action };
  if (action === 'start') {
    msg.startupCommand = server.startup_command || '';
    msg.preStartScript = server.pre_start_script || '';
    msg.serverConfig = {
      image: server.image,
      portMappings: JSON.parse(server.port_mappings || '[]'),
      envVars: [...JSON.parse(server.env_vars || '[]'), ...JSON.parse(server.secret_vars || '[]')],
      memoryLimit: server.memory_limit,
      cpuLimit: server.cpu_limit,
    };
  }

  audit(req.user.id, server.id, `power.${action}`, {}, req, req.apiKeyId);
  res.json({ ok: true });
  nodeManager.send(server.node_id, msg).then(result => {
    if (result?.containerId && result.containerId !== server.container_id)
      db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(result.containerId, server.id);
  }).catch(err => { console.error(`[v1 action] ${action} failed for ${server.id}:`, err.message); });
});

// DELETE /api/v1/servers/:id
router.delete('/servers/:id', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (server.suspended && req.user.role !== 'admin') return res.status(403).json({ error: 'Server is suspended' });
  audit(req.user.id, server.id, 'server.delete', { name: server.name }, req, req.apiKeyId);
  db.prepare("UPDATE servers SET status = 'deleting' WHERE id = ?").run(server.id);
  const io = nodeManager.io;
  if (io) {
    io.to(`user:${server.owner_id}`).to('admins').emit('server-deleted', { serverId: server.id });
    db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(server.id)
      .forEach(m => io.to(`user:${m.user_id}`).emit('server-deleted', { serverId: server.id }));
  }

  if (nodeManager.isOnline(server.node_id) && server.container_id) {
    await nodeManager.send(server.node_id, { type: 'delete-server', serverId: server.id, containerId: server.container_id }).catch(() => {});
    db.prepare("DELETE FROM servers WHERE id = ? AND status = 'deleting'").run(server.id);
  }
  // No container (still installing): install callback detects 'deleting' and cleans up
  // Node offline with container: cleanup job retries every 8s

  res.json({ ok: true });
});

// POST /api/v1/servers/:id/stdin  { data: "command\n" }
router.post('/servers/:id/stdin', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'console')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });
  if (server.status !== 'running') return res.status(400).json({ error: 'Server is not running' });
  const { data } = req.body;
  if (!data || typeof data !== 'string' || data.length > 256) return res.status(400).json({ error: 'Invalid data' });
  try {
    await nodeManager.send(server.node_id, { type: 'send-stdin', serverId: server.id, containerId: server.container_id, data });
    audit(req.user.id, server.id, 'console.command', { command: data.trim().slice(0, 100) }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/v1/servers/:id/settings  { name?, description?, startup_command?, env_vars? }
router.patch('/servers/:id/settings', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'settings')) return res.status(403).json({ error: 'Forbidden' });
  if (server.suspended && req.user.role !== 'admin') return res.status(403).json({ error: 'Server is suspended' });

  const { name, description, startup_command, env_vars, disk_limit, memory_limit, cpu_limit } = req.body;
  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(String(name).trim() || server.name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(String(description)); }
  if (startup_command !== undefined) { updates.push('startup_command = ?'); values.push(String(startup_command)); }
  if (env_vars !== undefined && Array.isArray(env_vars)) {
    const sanitized = env_vars.filter(e => e.key && String(e.key).trim()).map(e => ({ key: String(e.key).trim(), value: String(e.value ?? '') }));
    updates.push('env_vars = ?'); values.push(JSON.stringify(sanitized));
  }
  // Admin-only resource changes
  if (req.user.role === 'admin') {
    if (disk_limit !== undefined)   { updates.push('disk_limit = ?');   values.push(Math.max(0, parseInt(disk_limit) || 0)); }
    if (memory_limit !== undefined) { updates.push('memory_limit = ?'); values.push(Math.max(64, parseInt(memory_limit) || 512)); }
    if (cpu_limit !== undefined)    { updates.push('cpu_limit = ?');    values.push(Math.max(0.1, parseFloat(cpu_limit) || 1)); }
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  audit(req.user.id, server.id, 'server.settings', { changed: updates.map(u => u.split(' ')[0]) }, req, req.apiKeyId);
  res.json(formatServer(db.prepare('SELECT s.*, n.name as node_name, n.ip_address as node_ip_address FROM servers s JOIN nodes n ON s.node_id = n.id WHERE s.id = ?').get(req.params.id)));
});

// ── Files ─────────────────────────────────────────────────────────────────────

// GET /api/v1/servers/:id/files?path=/
router.get('/servers/:id/files', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  try {
    res.json(await nodeManager.send(server.node_id, fileMsg(server, { type: 'list-files', path: req.query.path || '/' })));
  } catch (err) { sendFileError(res, err); }
});

// GET /api/v1/servers/:id/files/read?path=/file.txt
router.get('/servers/:id/files/read', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try {
    res.json(await nodeManager.send(server.node_id, fileMsg(server, { type: 'read-file', path: req.query.path })));
  } catch (err) { sendFileError(res, err); }
});

// GET /api/v1/servers/:id/files/read-binary?path=/file.bin  (returns { content: "<base64>" })
router.get('/servers/:id/files/read-binary', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try {
    res.json(await nodeManager.send(server.node_id, fileMsg(server, { type: 'read-file-binary', path: req.query.path })));
  } catch (err) { sendFileError(res, err); }
});

// PUT /api/v1/servers/:id/files/write  { path, content }
router.put('/servers/:id/files/write', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id, fileMsg(server, { type: 'write-file', path: filePath, content: content ?? '' }));
    audit(req.user.id, server.id, 'file.write', { path: filePath }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/upload?path=/file.bin  body: raw bytes (base64 encoded in JSON { content })
router.post('/servers/:id/files/upload', express.raw({ type: '*/*', limit: '512mb' }), async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path query param is required' });
  try {
    const content = Buffer.isBuffer(req.body) ? req.body.toString('base64') : Buffer.from(String(req.body)).toString('base64');
    await nodeManager.send(server.node_id, fileMsg(server, { type: 'write-file', path: filePath, content, encoding: 'base64' }));
    audit(req.user.id, server.id, 'file.upload', { path: filePath }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/mkdir  { path }
router.post('/servers/:id/files/mkdir', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  if (!req.body.path) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id, fileMsg(server, { type: 'mkdir', path: req.body.path }));
    audit(req.user.id, server.id, 'file.mkdir', { path: req.body.path }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// DELETE /api/v1/servers/:id/files?path=/file.txt
router.delete('/servers/:id/files', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id, fileMsg(server, { type: 'delete-file', path: req.query.path }));
    audit(req.user.id, server.id, 'file.delete', { path: req.query.path }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/rename  { oldPath, newPath }
router.post('/servers/:id/files/rename', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });
  try {
    await nodeManager.send(server.node_id, fileMsg(server, { type: 'rename-file', oldPath, newPath }));
    audit(req.user.id, server.id, 'file.rename', { from: oldPath, to: newPath }, req, req.apiKeyId);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/extract  { path, dest? }
router.post('/servers/:id/files/extract', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { path: archivePath, dest } = req.body;
  if (!archivePath) return res.status(400).json({ error: 'path is required' });
  try {
    res.json(await nodeManager.send(server.node_id, fileMsg(server, { type: 'extract-archive', path: archivePath, dest: dest || null }), { timeout: 120000 }));
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/git  { url, branch?, folder?, path?, username?, token? }
router.post('/servers/:id/files/git', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { url, branch, folder, path: targetPath, username, token } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!validateGitUrl(url, res)) return;
  let authedUrl = url;
  if (username && token) {
    const p = new URL(url);
    p.username = encodeURIComponent(username);
    p.password = encodeURIComponent(token);
    authedUrl = p.toString();
  }
  try {
    res.json(await nodeManager.send(server.node_id, fileMsg(server, { type: 'git-clone', url: authedUrl, branch: branch || '', folder: folder || '', path: targetPath || '/home/container' }), { timeout: 300000 }));
    audit(req.user.id, server.id, 'file.git_clone', { url: url.replace(/\/\/[^@]+@/, '//[redacted]@') }, req, req.apiKeyId);
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/git-pull  { path?, strategy?, username?, token? }
router.post('/servers/:id/files/git-pull', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { path: targetPath, strategy, username, token } = req.body;
  const pullStrategy = ['ff-only', 'merge', 'rebase'].includes(strategy) ? strategy : 'ff-only';
  let authedUrl = null;
  if (username && token) {
    try {
      const remoteInfo = await nodeManager.send(server.node_id, fileMsg(server, { type: 'git-remote-url', path: targetPath || '/home/container' }), { timeout: 10000 }).catch(() => null);
      const remoteUrl = remoteInfo?.url;
      if (remoteUrl && /^https:\/\//i.test(remoteUrl)) {
        const p = new URL(remoteUrl);
        p.username = encodeURIComponent(username);
        p.password = encodeURIComponent(token);
        authedUrl = p.toString();
      }
    } catch {}
  }
  try {
    const pullResult = await nodeManager.send(server.node_id, fileMsg(server, { type: 'git-pull', path: targetPath || '/home/container', strategy: pullStrategy, ...(authedUrl ? { authedUrl } : {}) }), { timeout: 300000 });
    audit(req.user.id, server.id, 'file.git_pull', { path: targetPath || '/home/container', strategy: pullStrategy }, req, req.apiKeyId);
    res.json(pullResult);
  } catch (err) { sendFileError(res, err); }
});

// POST /api/v1/servers/:id/files/git-reset  { path?, commit?, mode? }
router.post('/servers/:id/files/git-reset', async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!checkFileAccess(server, req.user, res)) return;
  const { path: targetPath, commit, mode } = req.body;
  const resetMode = ['soft', 'mixed', 'hard'].includes(mode) ? mode : 'mixed';
  try {
    const resetResult = await nodeManager.send(server.node_id, fileMsg(server, { type: 'git-reset', path: targetPath || '/home/container', commit: commit || 'HEAD~1', mode: resetMode }), { timeout: 30000 });
    audit(req.user.id, server.id, 'file.git_reset', { path: targetPath || '/home/container', commit: commit || 'HEAD~1', mode: resetMode }, req, req.apiKeyId);
    res.json(resetResult);
  } catch (err) { sendFileError(res, err); }
});

// ── Presets ───────────────────────────────────────────────────────────────────

// GET /api/v1/presets
router.get('/presets', (req, res) => {
  const all = db.prepare('SELECT * FROM presets ORDER BY name ASC').all();
  const visible = req.user.role === 'admin'
    ? all
    : all.filter(p => !p.required_rank_id || checkRankAccess(req.user.id, p.required_rank_id));
  res.json(visible.map(p => ({
    ...p,
    env_vars: JSON.parse(p.env_vars || '[]'),
    images:   JSON.parse(p.images   || '[]'),
  })));
});

// GET /api/v1/presets/:id
router.get('/presets/:id', (req, res) => {
  const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!preset) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && !checkRankAccess(req.user.id, preset.required_rank_id))
    return res.status(403).json({ error: 'Your rank does not have access to this preset' });
  res.json({ ...preset, env_vars: JSON.parse(preset.env_vars || '[]'), images: JSON.parse(preset.images || '[]') });
});

// POST /api/v1/servers/from-preset  { name, preset_id, node_id?, image?, setup_var_values? }
router.post('/servers/from-preset', async (req, res) => {
  const { name, preset_id, node_id, image: chosenImage, setup_var_values } = req.body;
  if (!name || !preset_id) return res.status(400).json({ error: 'name and preset_id are required' });

  const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(preset_id);
  if (!preset) return res.status(404).json({ error: 'Preset not found' });

  if (req.user.role !== 'admin' && !checkRankAccess(req.user.id, preset.required_rank_id))
    return res.status(403).json({ error: 'Your rank does not have access to this preset' });

  let finalImage = preset.image;
  if (chosenImage && chosenImage !== preset.image) {
    const allowed = JSON.parse(preset.images || '[]').map(i => i.image);
    if (!allowed.includes(chosenImage)) return res.status(400).json({ error: 'Invalid image selection' });
    finalImage = chosenImage;
  }

  const memoryLimit = preset.memory_limit;
  const diskLimit   = preset.disk_limit || 0;

  const limitErr = checkAccountLimits(req.user.id, memoryLimit, diskLimit);
  if (limitErr) return res.status(403).json({ error: limitErr });

  const finalNodeId = findAvailableNode(node_id || null, memoryLimit, diskLimit);
  if (!finalNodeId) return res.status(503).json({ error: 'All nodes are full or offline.' });

  const id = uuidv4();
  const port_mappings  = autoPortMappings(finalNodeId);
  if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on this node. Ask an admin to expand the port range.' });
  const installScript  = preset.install_script   || '';
  const preStartScript = preset.pre_start_script || '';

  // Merge user-supplied setup var values into the preset's env vars
  let finalEnvVars = JSON.parse(preset.env_vars || '[]');
  const setupVars  = JSON.parse(preset.setup_vars || '[]');
  if (setup_var_values && typeof setup_var_values === 'object' && setupVars.length > 0) {
    const allowedKeys = new Set(setupVars.map(sv => sv.key));
    for (const [k, v] of Object.entries(setup_var_values)) {
      if (!allowedKeys.has(k)) continue;
      const idx = finalEnvVars.findIndex(e => e.key === k);
      if (idx >= 0) finalEnvVars[idx] = { key: k, value: String(v) };
      else finalEnvVars.push({ key: k, value: String(v) });
    }
  }

  db.prepare(`INSERT INTO servers
    (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name.trim(), preset.description || '', finalImage, finalNodeId, req.user.id,
      JSON.stringify(port_mappings), JSON.stringify(finalEnvVars), memoryLimit, preset.cpu_limit,
      diskLimit, preset.startup_command || '', installScript, preStartScript);

  audit(req.user.id, id, 'server.create', { preset: preset.name, name: name.trim() }, req, req.apiKeyId);

  nodeManager.send(finalNodeId, {
    type: 'install-server', serverId: id, image: finalImage,
    portMappings: port_mappings, envVars: finalEnvVars,
    memoryLimit, cpuLimit: preset.cpu_limit,
    startupCommand: preset.startup_command || '', installScript,
  }).then(data => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s) return;
    if (s.status === 'deleting') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      nodeManager.send(finalNodeId, { type: 'delete-server', serverId: id, containerId: data.containerId }).catch(() => {});
      return;
    }
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
  }).catch(err => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s || s.status === 'deleting') { db.prepare('DELETE FROM servers WHERE id = ?').run(id); return; }
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    console.error(`[v1] install failed for ${id}:`, err.message);
  });

  res.status(202).json({ id, status: 'installing', node_id: finalNodeId, port_mappings });
});

// ── Templates ─────────────────────────────────────────────────────────────────

// GET /api/v1/templates
router.get('/templates', (req, res) => {
  const all = db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
  const visible = req.user.role === 'admin'
    ? all
    : all.filter(t => !t.required_rank_id || checkRankAccess(req.user.id, t.required_rank_id));
  res.json(visible.map(t => ({
    ...t,
    env_vars: JSON.parse(t.env_vars || '[]'),
    files:    JSON.parse(t.files    || '[]'),
  })));
});

// GET /api/v1/templates/:id
router.get('/templates/:id', (req, res) => {
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && !checkRankAccess(req.user.id, tpl.required_rank_id))
    return res.status(403).json({ error: 'Your rank does not have access to this template' });
  res.json({ ...tpl, env_vars: JSON.parse(tpl.env_vars || '[]'), files: JSON.parse(tpl.files || '[]') });
});

// POST /api/v1/servers/from-template  { name, template_id, node_id? }
router.post('/servers/from-template', async (req, res) => {
  const { name, template_id, node_id } = req.body;
  if (!name || !template_id) return res.status(400).json({ error: 'name and template_id are required' });

  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  if (req.user.role !== 'admin' && !checkRankAccess(req.user.id, tpl.required_rank_id))
    return res.status(403).json({ error: 'Your rank does not have access to this template' });

  const memoryLimit = tpl.memory_limit;
  const diskLimit   = tpl.disk_limit || 0;

  const limitErr = checkAccountLimits(req.user.id, memoryLimit, diskLimit);
  if (limitErr) return res.status(403).json({ error: limitErr });

  const finalNodeId = findAvailableNode(node_id || null, memoryLimit, diskLimit);
  if (!finalNodeId) return res.status(503).json({ error: 'All nodes are full or offline.' });

  const id = uuidv4();
  const port_mappings  = autoPortMappings(finalNodeId);
  if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on this node. Ask an admin to expand the port range.' });
  const files          = JSON.parse(tpl.files || '[]');
  const installScript  = tpl.install_script   || '';
  const preStartScript = tpl.pre_start_script || '';

  db.prepare(`INSERT INTO servers
    (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name.trim(), tpl.description || '', tpl.image, finalNodeId, req.user.id,
      JSON.stringify(port_mappings), tpl.env_vars || '[]', memoryLimit, tpl.cpu_limit,
      diskLimit, tpl.startup_command || '', installScript, preStartScript);

  audit(req.user.id, id, 'server.create', { template: tpl.name, name: name.trim() }, req, req.apiKeyId);

  nodeManager.send(finalNodeId, {
    type: 'install-server', serverId: id, image: tpl.image,
    portMappings: port_mappings, envVars: JSON.parse(tpl.env_vars || '[]'),
    memoryLimit, cpuLimit: tpl.cpu_limit,
    startupCommand: tpl.startup_command || '', installScript,
  }).then(async data => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s) return;
    if (s.status === 'deleting') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      nodeManager.send(finalNodeId, { type: 'delete-server', serverId: id, containerId: data.containerId }).catch(() => {});
      return;
    }
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
    if (files.length) {
      await nodeManager.send(finalNodeId, { type: 'write-files', serverId: id, files }, { timeout: 30000 }).catch(err => {
        console.error(`[v1] write-files failed for ${id}:`, err.message);
      });
    }
  }).catch(err => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s || s.status === 'deleting') { db.prepare('DELETE FROM servers WHERE id = ?').run(id); return; }
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    console.error(`[v1] install failed for ${id}:`, err.message);
  });

  res.status(202).json({ id, status: 'installing', node_id: finalNodeId, port_mappings });
});

// ── Activity / audit log ──────────────────────────────────────────────────────

// GET /api/v1/servers/:id/activity?limit=50&offset=0
router.get('/servers/:id/activity', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const limit  = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
  const offset = Math.max(parseInt(req.query.offset) || 0,  0);

  const logs = db.prepare(`
    SELECT al.id, al.user_id, al.action, al.metadata, al.ip, al.created_at, al.api_key_id,
           u.username, u.avatar,
           ak.name as api_key_name
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN api_keys ak ON al.api_key_id = ak.id
    WHERE al.server_id = ?
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as n FROM audit_logs WHERE server_id = ?').get(req.params.id)?.n ?? 0;

  res.json({
    logs: logs.map(l => ({ ...l, metadata: (() => { try { return JSON.parse(l.metadata || '{}'); } catch { return {}; } })() })),
    total,
    limit,
    offset,
  });
});

// ── Members ───────────────────────────────────────────────────────────────────

// GET /api/v1/servers/:id/members
router.get('/servers/:id/members', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const members = db.prepare(`
    SELECT sm.user_id, sm.permissions, sm.created_at, u.username, u.avatar
    FROM server_members sm JOIN users u ON sm.user_id = u.id
    WHERE sm.server_id = ? ORDER BY sm.created_at ASC
  `).all(req.params.id);

  res.json(members.map(m => ({ ...m, permissions: JSON.parse(m.permissions || '[]') })));
});

// POST /api/v1/servers/:id/members  { username, permissions: ["console","files","power","settings"] }
router.post('/servers/:id/members', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { username, permissions } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const validPerms = ['console', 'files', 'settings', 'power', 'sharelog', 'sharefile'];
  const perms = Array.isArray(permissions) ? permissions.filter(p => validPerms.includes(p)) : ['console'];

  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === server.owner_id) return res.status(400).json({ error: 'Cannot add server owner as member' });

  db.prepare(`INSERT INTO server_members (server_id, user_id, permissions) VALUES (?, ?, ?)
    ON CONFLICT(server_id, user_id) DO UPDATE SET permissions = excluded.permissions`)
    .run(req.params.id, target.id, JSON.stringify(perms));

  audit(req.user.id, server.id, 'members.add', { userId: target.id, username, permissions: perms }, req, req.apiKeyId);
  res.json({ ok: true, user_id: target.id, permissions: perms });
});

// PATCH /api/v1/servers/:id/members/:userId  { permissions: [...] }
router.patch('/servers/:id/members/:userId', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const validPerms = ['console', 'files', 'settings', 'power', 'sharelog', 'sharefile'];
  const perms = Array.isArray(req.body.permissions) ? req.body.permissions.filter(p => validPerms.includes(p)) : [];

  const result = db.prepare('UPDATE server_members SET permissions = ? WHERE server_id = ? AND user_id = ?')
    .run(JSON.stringify(perms), req.params.id, req.params.userId);
  if (!result.changes) return res.status(404).json({ error: 'Member not found' });

  audit(req.user.id, server.id, 'members.update', { userId: req.params.userId, permissions: perms }, req, req.apiKeyId);
  res.json({ ok: true, permissions: perms });
});

// DELETE /api/v1/servers/:id/members/:userId
router.delete('/servers/:id/members/:userId', (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  audit(req.user.id, server.id, 'members.remove', { userId: req.params.userId }, req, req.apiKeyId);
  res.json({ ok: true });
});

module.exports = router;
