const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth);

function canAccess(server, user) {
  return user.role === 'admin' || server.owner_id === user.id;
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

// Returns the rank resource limits for a user (memory_limit, disk_limit in MB; 0 = no limit)
function getRankLimits(userId) {
  const row = db.prepare(`
    SELECT r.memory_limit, r.disk_limit
    FROM users u LEFT JOIN ranks r ON u.rank_id = r.id
    WHERE u.id = ?
  `).get(userId);
  return { memory_limit: row?.memory_limit ?? 0, disk_limit: row?.disk_limit ?? 0 };
}

// Find the best online node that can fit the requested resources.
// Prefers preferNodeId if it has capacity; otherwise picks the node with the most free RAM.
function findAvailableNode(preferNodeId, memoryMb, diskMb) {
  const allNodes = db.prepare('SELECT * FROM nodes').all();
  const online = allNodes.filter(n => nodeManager.isOnline(n.id));

  // Try the preferred node first
  if (preferNodeId) {
    const pref = online.find(n => n.id === preferNodeId);
    if (pref && !checkNodeCapacity(pref.id, memoryMb, diskMb)) return pref.id;
  }

  // Rank remaining nodes by most free memory
  const others = online
    .filter(n => n.id !== preferNodeId)
    .map(n => {
      const used = db.prepare('SELECT COALESCE(SUM(memory_limit), 0) as u FROM servers WHERE node_id = ?').get(n.id)?.u ?? 0;
      return { id: n.id, free: n.memory - used };
    })
    .sort((a, b) => b.free - a.free);

  for (const n of others) {
    if (!checkNodeCapacity(n.id, memoryMb, diskMb)) return n.id;
  }
  return null;
}

function checkServerLimit(userId) {
  const userData = db.prepare(`
    SELECT u.role, r.max_servers
    FROM users u LEFT JOIN ranks r ON u.rank_id = r.id
    WHERE u.id = ?
  `).get(userId);
  if (!userData || userData.role === 'admin') return null; // admins unlimited
  const max = userData.max_servers ?? 1;
  if (max === -1) return null; // unlimited rank
  const count = db.prepare('SELECT COUNT(*) as n FROM servers WHERE owner_id = ?').get(userId)?.n ?? 0;
  if (count >= max) return `Server limit reached (${count}/${max}). Ask an admin to upgrade your rank.`;
  return null;
}

router.get('/', (req, res) => {
  const servers = req.user.role === 'admin'
    ? db.prepare('SELECT s.*, u.username as owner_name, n.name as node_name FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id ORDER BY s.created_at DESC').all()
    : db.prepare('SELECT s.*, u.username as owner_name, n.name as node_name FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id WHERE s.owner_id = ? ORDER BY s.created_at DESC').all(req.user.id);

  res.json(servers.map(s => ({
    ...s,
    port_mappings: JSON.parse(s.port_mappings),
    env_vars: JSON.parse(s.env_vars),
    node_online: nodeManager.isOnline(s.node_id),
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
    node_online: nodeManager.isOnline(server.node_id),
  });
});

router.post('/from-preset', async (req, res) => {
  const { name, preset_id, node_id } = req.body;
  if (!name || !preset_id) return res.status(400).json({ error: 'name and preset_id are required' });

  const limitErr = checkServerLimit(req.user.id);
  if (limitErr) return res.status(403).json({ error: limitErr });

  const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(preset_id);
  if (!preset) return res.status(404).json({ error: 'Preset not found' });

  // Apply rank resource defaults for non-admins
  let memoryLimit = preset.memory_limit;
  let diskLimit = 0;
  if (req.user.role !== 'admin') {
    const rankLimits = getRankLimits(req.user.id);
    if (rankLimits.memory_limit > 0) memoryLimit = Math.min(memoryLimit, rankLimits.memory_limit);
    if (rankLimits.disk_limit > 0) diskLimit = rankLimits.disk_limit;
  }

  // Find a node with enough capacity — prefer requested node, fall back to next available
  const finalNodeId = findAvailableNode(node_id || null, memoryLimit, diskLimit);
  if (!finalNodeId) {
    return res.status(503).json({ error: 'No nodes have enough capacity to create this server. Ask an admin to add more resources.' });
  }
  if (!nodeManager.isOnline(finalNodeId)) {
    return res.status(503).json({ error: 'Node is offline' });
  }
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(finalNodeId);

  const id = uuidv4();
  const port_mappings = JSON.parse(preset.port_mappings);
  const env_vars = JSON.parse(preset.env_vars);

  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, preset.description, preset.image, finalNodeId, req.user.id, preset.port_mappings, preset.env_vars, memoryLimit, preset.cpu_limit, diskLimit, preset.startup_command || '');

  nodeManager.send(finalNodeId, {
    type: 'install-server',
    serverId: id,
    image: preset.image,
    portMappings: port_mappings,
    envVars: env_vars,
    memoryLimit: memoryLimit,
    cpuLimit: preset.cpu_limit,
    startupCommand: preset.startup_command || '',
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
    port_mappings = [], env_vars = [],
    memory_limit = 512, cpu_limit = 1.0,
  } = req.body;

  if (!name || !image || !node_id) return res.status(400).json({ error: 'name, image, and node_id are required' });

  const targetOwner = owner_id || req.user.id;
  const limitErr = checkServerLimit(targetOwner);
  if (limitErr) return res.status(403).json({ error: limitErr });
  const disk_limit_val = Math.max(0, parseInt(req.body.disk_limit) || 0);
  const actualNodeId = findAvailableNode(node_id, memory_limit, disk_limit_val);
  if (!actualNodeId) return res.status(503).json({ error: 'No nodes have enough capacity for this server.' });
  if (!nodeManager.isOnline(actualNodeId)) return res.status(503).json({ error: 'Node is offline' });

  const id = uuidv4();

  const startup_command = req.body.startup_command || '';
  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, description, image, actualNodeId, targetOwner, JSON.stringify(port_mappings), JSON.stringify(env_vars), memory_limit, cpu_limit, disk_limit_val, startup_command);

  // Send install command to daemon — async, don't block response
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });

  const { action } = req.body;
  const validActions = ['start', 'stop', 'restart', 'kill', 'sigint', 'sigterm'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const msg = {
    type: 'server-action',
    serverId: server.id,
    containerId: server.container_id,
    action,
  };

  if (action === 'start') {
    msg.startupCommand = server.startup_command || '';
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

// ── File manager ─────────────────────────────────────────────────────────────
function fileMsg(server, extra) {
  return { serverId: server.id, containerId: server.container_id, ...extra };
}

router.get('/:id/files', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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

router.post('/:id/files/rename', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { name, description, startup_command, disk_limit } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name.trim() || server.name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (startup_command !== undefined) { updates.push('startup_command = ?'); values.push(startup_command); }
  if (disk_limit !== undefined && req.user.role === 'admin') { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  res.json({ ...updated, port_mappings: JSON.parse(updated.port_mappings), env_vars: JSON.parse(updated.env_vars) });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });

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

router.get('/:id/stats', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  if (!nodeManager.isOnline(server.node_id)) return res.json({ cpu: 0, memory: 0, status: 'node_offline' });
  if (!server.container_id || server.status !== 'running') return res.json({ cpu: 0, memory: 0, status: server.status });

  try {
    const stats = await nodeManager.send(server.node_id, {
      type: 'get-stats',
      serverId: server.id,
      containerId: server.container_id,
    });
    res.json({ ...stats, diskLimit: server.disk_limit || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
