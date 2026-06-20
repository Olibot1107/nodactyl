const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth);

function getMember(serverId, userId) {
  return db.prepare('SELECT permissions FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function canAccess(server, user) {
  if (user.role === 'admin' || server.owner_id === user.id) return true;
  return !!getMember(server.id, user.id);
}

function hasPerm(server, user, perm) {
  if (user.role === 'admin' || server.owner_id === user.id) return true;
  const member = getMember(server.id, user.id);
  if (!member) return false;
  try { return JSON.parse(member.permissions).includes(perm); } catch { return false; }
}

function suspendedBlock(server, user) {
  if (server.suspended && user.role !== 'admin') return { status: 403, error: 'Server is suspended' };
  return null;
}

function fileAccessError(server) {
  if (!nodeManager.isOnline(server.node_id)) return { status: 503, error: 'Node is offline. Start the daemon on this node to access files.' };
  return null;
}

function sendFileError(res, err) {
  const message = err.message || 'File operation failed';
  if (/no such file|not found/i.test(message)) return res.status(404).json({ error: message });
  if (/is a directory|cannot read a directory/i.test(message)) return res.status(400).json({ error: message });
  return res.status(500).json({ error: message });
}

function checkNodeCapacity(nodeId, addMemoryMb, addDiskMb) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return 'Node not found';

  // Memory: node.memory is total RAM in MB; every server must allocate memory
  if (node.memory > 0) {
    const usedMem = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as used FROM servers WHERE node_id = ?').get(nodeId)?.used ?? 0;
    const free = node.memory - usedMem;
    if (addMemoryMb > free) {
      return `Not enough memory on this node. Requested: ${addMemoryMb} MB, Available: ${Math.max(0, free)} MB`;
    }
  }

  // Disk: only tracked when both node and the new server have a non-zero disk_limit
  if (node.disk_limit > 0 && addDiskMb > 0) {
    const usedDisk = db.prepare('SELECT COALESCE(SUM(disk_limit), 0) as used FROM servers WHERE node_id = ? AND disk_limit > 0').get(nodeId)?.used ?? 0;
    const free = node.disk_limit - usedDisk;
    if (addDiskMb > free) {
      return `Not enough disk on this node. Requested: ${addDiskMb} MB, Available: ${Math.max(0, free)} MB`;
    }
  }

  return null;
}

// Find the best online node that can fit the requested resources.
// Prefers preferNodeId if it has capacity; otherwise picks the node with the most free RAM.
function findAvailableNode(preferNodeId, memoryMb, diskMb) {
  const online = db.prepare('SELECT * FROM nodes').all().filter(n => nodeManager.isOnline(n.id));

  if (preferNodeId) {
    const pref = online.find(n => n.id === preferNodeId);
    if (pref && !checkNodeCapacity(pref.id, memoryMb, diskMb)) return pref.id;
  }

  // Try all other online nodes, sorted by most free RAM
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

// Check that creating a server won't exceed the user's account-level quotas (total across all their servers).
// Admins bypass all limits. Returns an error string or null.
function checkAccountLimits(userId, addMemoryMb, addDiskMb) {
  const data = db.prepare(`
    SELECT u.role, r.max_servers, r.memory_limit, r.disk_limit
    FROM users u LEFT JOIN ranks r ON u.rank_id = r.id
    WHERE u.id = ?
  `).get(userId);
  if (!data || data.role === 'admin') return null;

  // Max servers
  const maxServers = data.max_servers ?? 1;
  if (maxServers !== -1) {
    const count = db.prepare('SELECT COUNT(*) as n FROM servers WHERE owner_id = ?').get(userId)?.n ?? 0;
    if (count >= maxServers) return `Server limit reached (${count}/${maxServers}). Ask an admin to upgrade your rank.`;
  }

  // Total memory quota
  if (data.memory_limit > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as u FROM servers WHERE owner_id = ?').get(userId)?.u ?? 0;
    if (used + addMemoryMb > data.memory_limit) {
      return `Not enough memory quota. You have ${data.memory_limit - used} MB remaining but this preset needs ${addMemoryMb} MB.`;
    }
  }

  // Total disk quota
  if (data.disk_limit > 0 && addDiskMb > 0) {
    const used = db.prepare('SELECT COALESCE(SUM(disk_limit), 0) as u FROM servers WHERE owner_id = ? AND disk_limit > 0').get(userId)?.u ?? 0;
    if (used + addDiskMb > data.disk_limit) {
      return `Not enough disk quota. You have ${data.disk_limit - used} MB remaining but this preset needs ${addDiskMb} MB.`;
    }
  }

  return null;
}

router.get('/', (req, res) => {
  const servers = req.user.role === 'admin'
    ? db.prepare('SELECT s.*, u.username as owner_name, n.name as node_name FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id ORDER BY s.created_at DESC').all()
    : db.prepare(`SELECT s.*, u.username as owner_name, n.name as node_name,
    CASE WHEN s.owner_id = ? THEN 0 ELSE 1 END as shared,
    (SELECT sm.permissions FROM server_members sm WHERE sm.server_id = s.id AND sm.user_id = ?) as member_permissions
    FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id
    WHERE s.owner_id = ? OR s.id IN (SELECT server_id FROM server_members WHERE user_id = ?)
    ORDER BY s.created_at DESC`).all(req.user.id, req.user.id, req.user.id, req.user.id);

  res.json(servers.map(s => ({
    ...s,
    port_mappings: JSON.parse(s.port_mappings),
    env_vars: JSON.parse(s.env_vars),
    discord_config: s.discord_config ? JSON.parse(s.discord_config) : null,
    node_online: nodeManager.isOnline(s.node_id),
    shared: s.shared || 0,
    member_permissions: s.member_permissions || null,
  })));
});

router.get('/:id', (req, res) => {
  const server = db.prepare('SELECT s.*, u.username as owner_name, n.name as node_name FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id WHERE s.id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });

  res.json({
    ...server,
    port_mappings: JSON.parse(server.port_mappings),
    env_vars: JSON.parse(server.env_vars),
    discord_config: server.discord_config ? JSON.parse(server.discord_config) : null,
    node_online: nodeManager.isOnline(server.node_id),
  });
});

function getUsedPorts(nodeId) {
  const rows = db.prepare('SELECT port_mappings FROM servers WHERE node_id = ?').all(nodeId);
  const used = new Set();
  for (const row of rows) {
    try {
      for (const m of JSON.parse(row.port_mappings)) {
        if (m.hostPort) used.add(Number(m.hostPort));
      }
    } catch {}
  }
  return used;
}

function findAvailablePort(nodeId, extraUsed = new Set()) {
  const node = db.prepare('SELECT port_range_start, port_range_end FROM nodes WHERE id = ?').get(nodeId);
  const rangeStart = node?.port_range_start ?? 10000;
  const rangeEnd   = node?.port_range_end   ?? 30000;
  const used = getUsedPorts(nodeId);
  for (const p of extraUsed) used.add(p);
  for (let p = rangeStart; p <= rangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

function autoPortMappings(nodeId) {
  const hostPort = findAvailablePort(nodeId, new Set());
  if (!hostPort) return [];
  return [
    { hostPort, containerPort: hostPort, protocol: 'tcp' },
    { hostPort, containerPort: hostPort, protocol: 'udp' },
  ];
}

router.post('/from-preset', async (req, res) => {
  const { name, preset_id, node_id } = req.body;
  if (!name || !preset_id) return res.status(400).json({ error: 'name and preset_id are required' });

  const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(preset_id);
  if (!preset) return res.status(404).json({ error: 'Preset not found' });

  // Rank gate — check if user has access to this preset
  if (req.user.role !== 'admin' && preset.required_rank_id) {
    const canUse = (() => {
      if (!req.user.rank_id) return false;
      const uRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(req.user.rank_id);
      const rRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(preset.required_rank_id);
      return uRank && rRank && uRank.sort_order >= rRank.sort_order;
    })();
    if (!canUse) return res.status(403).json({ error: 'Your rank does not have access to this preset' });
  }

  // Preset defines exact resources — no per-server rank capping
  const memoryLimit = preset.memory_limit;
  const diskLimit   = preset.disk_limit || 0;

  // Check account-level quotas (total RAM + disk across all user's servers)
  const limitErr = checkAccountLimits(req.user.id, memoryLimit, diskLimit);
  if (limitErr) return res.status(403).json({ error: limitErr });

  // Find a node with enough capacity — prefers requested node, auto-fails over to next best
  const finalNodeId = findAvailableNode(node_id || null, memoryLimit, diskLimit);
  if (!finalNodeId) {
    return res.status(503).json({ error: 'All nodes are full or offline. Try again later or ask an admin to add capacity.' });
  }

  const id = uuidv4();
  const port_mappings = autoPortMappings(finalNodeId);
  const env_vars = JSON.parse(preset.env_vars);

  const installScript = preset.install_script || '';
  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, preset.description, preset.image, finalNodeId, req.user.id, JSON.stringify(port_mappings), preset.env_vars, memoryLimit, preset.cpu_limit, diskLimit, preset.startup_command || '', installScript);

  nodeManager.send(finalNodeId, {
    type: 'install-server',
    serverId: id,
    image: preset.image,
    portMappings: port_mappings,
    envVars: env_vars,
    memoryLimit: memoryLimit,
    cpuLimit: preset.cpu_limit,
    startupCommand: preset.startup_command || '',
    installScript,
  }).then(data => {
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
  }).catch(err => {
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    console.error(`Failed to install server ${id}:`, err.message);
  });

  res.status(202).json({ id, status: 'installing' });
});

router.post('/', requireAdmin, async (req, res) => {
  const {
    name, description = '', image, node_id, owner_id,
    env_vars = [],
    memory_limit = 512, cpu_limit = 1.0,
  } = req.body;

  if (!name || !image || !node_id) return res.status(400).json({ error: 'name, image, and node_id are required' });

  const targetOwner = owner_id || req.user.id;
  const disk_limit_val = Math.max(0, parseInt(req.body.disk_limit) || 0);
  const limitErr = checkAccountLimits(targetOwner, memory_limit, disk_limit_val);
  if (limitErr) return res.status(403).json({ error: limitErr });
  const actualNodeId = findAvailableNode(node_id, memory_limit, disk_limit_val);
  if (!actualNodeId) return res.status(503).json({ error: 'All nodes are full or offline.' });

  const port_mappings = autoPortMappings(actualNodeId);

  const id = uuidv4();
  const startup_command = req.body.startup_command || '';
  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, description, image, actualNodeId, targetOwner, JSON.stringify(port_mappings), JSON.stringify(env_vars), memory_limit, cpu_limit, disk_limit_val, startup_command);

  nodeManager.send(actualNodeId, {
    type: 'install-server',
    serverId: id,
    image,
    portMappings: port_mappings,
    envVars: env_vars,
    memoryLimit: memory_limit,
    cpuLimit: cpu_limit,
    startupCommand: req.body.startup_command || '',
  }).then(data => {
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
  }).catch(err => {
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    console.error(`Failed to install server ${id}:`, err.message);
  });

  res.status(202).json({ id, status: 'installing' });
});

router.post('/:id/action', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'power')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });

  const { action } = req.body;
  const validActions = ['start', 'stop', 'restart', 'kill', 'sigint', 'sigterm'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (server.status === 'installing') return res.status(400).json({ error: 'Server is still installing' });
  if (action === 'start' && server.suspended) return res.status(403).json({ error: 'Server is suspended' });

  const msg = {
    type: 'server-action',
    serverId: server.id,
    containerId: server.container_id,
    action,
  };

  if (action === 'start') {
    const terminalMode = req.body.terminalMode === true;
    msg.startupCommand = terminalMode ? 'sh' : (server.startup_command || '');
    db.prepare('UPDATE servers SET terminal_mode = ? WHERE id = ?').run(terminalMode ? 1 : 0, server.id);
    msg.serverConfig = {
      image: server.image,
      portMappings: JSON.parse(server.port_mappings),
      envVars: JSON.parse(server.env_vars),
      memoryLimit: server.memory_limit,
      cpuLimit: server.cpu_limit,
    };
  }

  // Respond immediately — Docker events + Socket.IO update the actual status
  res.json({ ok: true });

  // Background: persist new container ID if daemon recreated the container
  nodeManager.send(server.node_id, msg).then(result => {
    if (result?.containerId && result.containerId !== server.container_id) {
      db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(result.containerId, server.id);
    }
  }).catch(err => {
    console.error(`[action] ${action} failed for ${server.id}:`, err.message);
  });
});

router.post('/:id/suspend', requireAdmin, async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE servers SET suspended = 1 WHERE id = ?').run(req.params.id);
  // Stop the container if running so the user can't keep using it
  if (server.container_id && nodeManager.isOnline(server.node_id)) {
    nodeManager.send(server.node_id, {
      type: 'server-action', serverId: server.id, containerId: server.container_id, action: 'stop',
    }).catch(() => {});
  }
  res.json({ ok: true });
});

router.post('/:id/unsuspend', requireAdmin, (req, res) => {
  const result = db.prepare('UPDATE servers SET suspended = 0 WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── File manager ─────────────────────────────────────────────────────────────
function fileMsg(server, extra) {
  return { serverId: server.id, containerId: server.container_id, ...extra };
}

router.get('/:id/files', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  try {
    const result = await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'list-files', path: req.query.path || '/' }));
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.get('/:id/files/read', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  try {
    const result = await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'read-file', path: filePath }));
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.put('/:id/files/write', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'write-file', path: filePath, content: content ?? '' }));
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/upload', express.raw({ type: '*/*', limit: '512mb' }), async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path query param is required' });
  try {
    const content = req.body.toString('base64');
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'write-file', path: filePath, content, encoding: 'base64' }));
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/mkdir', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'mkdir', path: dirPath }));
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.delete('/:id/files', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  try {
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'delete-file', path: filePath }));
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { url, branch, folder, path: targetPath } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!/^https:\/\/.+/.test(url)) return res.status(400).json({ error: 'Only https:// URLs are supported' });
  try {
    const host = new URL(url).hostname;
    if (/^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fd[0-9a-f]{2}:)/i.test(host)) {
      return res.status(400).json({ error: 'Private or loopback URLs are not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'git-clone', url, branch: branch || '', folder: folder || '', path: targetPath || '/home/container' }),
      { timeout: 300000 }  // 5 minutes for large repos
    );
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git-pull', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: targetPath, strategy } = req.body;
  const validStrategies = ['ff-only', 'merge', 'rebase'];
  const pullStrategy = validStrategies.includes(strategy) ? strategy : 'ff-only';
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'git-pull', path: targetPath || '/home/container', strategy: pullStrategy }),
      { timeout: 300000 }
    );
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git-reset', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: targetPath, commit, mode } = req.body;
  const validModes = ['soft', 'mixed', 'hard'];
  const resetMode = validModes.includes(mode) ? mode : 'mixed';
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'git-reset', path: targetPath || '/home/container', commit: commit || 'HEAD~1', mode: resetMode }),
      { timeout: 30000 }
    );
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/rename', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });
  try {
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'rename-file', oldPath, newPath }));
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.patch('/:id/settings', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'settings')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr2 = suspendedBlock(server, req.user); if (suspErr2) return res.status(suspErr2.status).json({ error: suspErr2.error });
  const { name, description, startup_command, disk_limit, memory_limit, cpu_limit, discord_webhook, discord_config, env_vars } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name.trim() || server.name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (startup_command !== undefined) { updates.push('startup_command = ?'); values.push(startup_command); }
  if (disk_limit !== undefined && req.user.role === 'admin') { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (memory_limit !== undefined && req.user.role === 'admin') { updates.push('memory_limit = ?'); values.push(Math.max(64, parseInt(memory_limit) || 512)); }
  if (cpu_limit !== undefined && req.user.role === 'admin') { updates.push('cpu_limit = ?'); values.push(Math.max(0.1, parseFloat(cpu_limit) || 1)); }
  if (discord_webhook !== undefined) {
    const url = discord_webhook?.trim() || null;
    if (url && !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url)) {
      return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }
    updates.push('discord_webhook = ?');
    values.push(url);
  }
  if (env_vars !== undefined && Array.isArray(env_vars)) {
    const sanitized = env_vars.filter(e => e.key && String(e.key).trim()).map(e => ({ key: String(e.key).trim(), value: String(e.value ?? '') }));
    updates.push('env_vars = ?');
    values.push(JSON.stringify(sanitized));
  }
  if (discord_config !== undefined) {
    const cfg = discord_config ? {
      events: (Array.isArray(discord_config.events) ? discord_config.events : ['running', 'stopped', 'error'])
        .filter(e => ['running', 'stopped', 'error'].includes(e)),
      mention: discord_config.mention ? String(discord_config.mention).slice(0, 100) : null,
      username: discord_config.username ? String(discord_config.username).slice(0, 80) : null,
    } : null;
    updates.push('discord_config = ?');
    values.push(cfg ? JSON.stringify(cfg) : null);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  res.json({ ...updated, port_mappings: JSON.parse(updated.port_mappings), env_vars: JSON.parse(updated.env_vars), discord_config: updated.discord_config ? JSON.parse(updated.discord_config) : null });
});

router.delete('/:id', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const suspErr3 = suspendedBlock(server, req.user); if (suspErr3) return res.status(suspErr3.status).json({ error: suspErr3.error });

  if (nodeManager.isOnline(server.node_id) && server.container_id) {
    await nodeManager.send(server.node_id, {
      type: 'delete-server',
      serverId: server.id,
      containerId: server.container_id,
    }).catch(() => {});
  }

  db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  res.json({ ok: true });
});

router.post('/:id/stdin', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'console')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });
  if (server.status !== 'running') return res.status(400).json({ error: 'Server is not running' });
  const { data } = req.body;
  if (!data || typeof data !== 'string' || data.length > 256) return res.status(400).json({ error: 'Invalid data' });
  try {
    await nodeManager.send(server.node_id, {
      type: 'send-stdin', serverId: server.id, containerId: server.container_id, data,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/packages', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user);
  if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  if (server.status !== 'stopped') return res.status(400).json({ error: 'Server must be stopped to install packages' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });

  const VALID_MANAGERS = ['npm', 'yarn', 'pip', 'pip3', 'composer', 'gem', 'cargo'];
  const { manager, pkg = '' } = req.body;

  if (!manager || !VALID_MANAGERS.includes(manager))
    return res.status(400).json({ error: 'Invalid package manager' });

  const isManifestInstall = !pkg || pkg.trim() === '';
  // Manifest installs (npm install, pip install -r requirements.txt, etc.) are safe — no user pkg string
  if (!isManifestInstall) {
    if (typeof pkg !== 'string' || pkg.length > 500)
      return res.status(400).json({ error: 'Invalid package name' });
    if (/[;&|`$!'"\\{}()\n\r]/.test(pkg))
      return res.status(400).json({ error: 'Invalid characters in package name' });
  }

  let envVars = [];
  try { envVars = JSON.parse(server.env_vars || '[]'); } catch {}

  try {
    await nodeManager.send(server.node_id, {
      type: 'install-package',
      serverId: server.id,
      image: server.image,
      envVars,
      memoryLimit: server.memory_limit,
      manager,
      pkg: isManifestInstall ? '' : pkg.trim(),
    }, { timeout: 300000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/stats', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'console')) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.json({ cpu: 0, memory: 0, status: 'node_offline' });
  if (!server.container_id || server.status !== 'running') return res.json({ cpu: 0, memory: 0, status: server.status });

  try {
    const stats = await nodeManager.send(server.node_id, {
      type: 'get-stats',
      serverId: server.id,
      containerId: server.container_id,
    });
    // Enforce disk limit immediately when stats are checked
    if (server.disk_limit > 0 && stats.diskUsed > server.disk_limit * 1024 * 1024) {
      nodeManager.send(server.node_id, {
        type: 'server-action', serverId: server.id, containerId: server.container_id, action: 'kill',
      }, { timeout: 10000 }).catch(() => {});
    }
    res.json({ ...stats, diskLimit: server.disk_limit || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server members ─────────────────────────────────────────────────────────

router.get('/:id/members', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const members = db.prepare(`SELECT sm.user_id, sm.permissions, sm.created_at, u.username, u.email, u.avatar
    FROM server_members sm JOIN users u ON sm.user_id = u.id
    WHERE sm.server_id = ? ORDER BY sm.created_at ASC`).all(req.params.id);
  res.json(members.map(m => ({ ...m, permissions: JSON.parse(m.permissions || '[]') })));
});

router.post('/:id/members', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { username, permissions } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const validPerms = ['console', 'files', 'settings', 'power'];
  const perms = Array.isArray(permissions) ? permissions.filter(p => validPerms.includes(p)) : ['console'];
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === server.owner_id) return res.status(400).json({ error: 'Cannot add server owner as member' });
  db.prepare(`INSERT INTO server_members (server_id, user_id, permissions) VALUES (?, ?, ?)
    ON CONFLICT(server_id, user_id) DO UPDATE SET permissions = excluded.permissions`)
    .run(req.params.id, target.id, JSON.stringify(perms));
  res.json({ ok: true });
});

router.patch('/:id/members/:userId', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const validPerms = ['console', 'files', 'settings', 'power'];
  const perms = Array.isArray(req.body.permissions) ? req.body.permissions.filter(p => validPerms.includes(p)) : [];
  const result = db.prepare('UPDATE server_members SET permissions = ? WHERE server_id = ? AND user_id = ?')
    .run(JSON.stringify(perms), req.params.id, Number(req.params.userId));
  if (!result.changes) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, Number(req.params.userId));
  res.json({ ok: true });
});

module.exports = router;
