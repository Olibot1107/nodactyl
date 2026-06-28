const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');
const { audit } = require('../audit');
const log = require('../log');

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

// Broadcast a server-deleted event to everyone who has access (owner + members + admins).
// Called as soon as status is set to 'deleting', before the async daemon call, so the
// browser removes the card immediately rather than waiting for container cleanup to finish.
function emitServerDeleted(server) {
  const io = nodeManager.io;
  if (!io) return;
  io.to(`user:${server.owner_id}`).to('admins').emit('server-deleted', { serverId: server.id });
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(server.id);
  members.forEach(m => io.to(`user:${m.user_id}`).emit('server-deleted', { serverId: server.id }));
}

function fileAccessError(server) {
  if (!nodeManager.isOnline(server.node_id)) return { status: 503, error: 'Node is offline. Start the daemon on this node to access files.' };
  return null;
}

function sendFileError(res, err) {
  const message = err.message || 'File operation failed';
  if (/no such file|not found/i.test(message)) return res.status(404).json({ error: message });
  if (/is a directory|cannot read a directory/i.test(message)) return res.status(400).json({ error: message });
  if (/unsupported archive|not installed on this node|cannot extract/i.test(message)) return res.status(400).json({ error: message });
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
    const count = db.prepare("SELECT COUNT(*) as n FROM servers WHERE owner_id = ? AND status != 'deleting'").get(userId)?.n ?? 0;
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
    ? db.prepare("SELECT s.*, u.username as owner_name, n.name as node_name, n.ip_address as node_ip_address FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id WHERE s.status != 'deleting' ORDER BY s.created_at DESC").all()
    : db.prepare(`SELECT s.*, u.username as owner_name, n.name as node_name, n.ip_address as node_ip_address,
    CASE WHEN s.owner_id = ? THEN 0 ELSE 1 END as shared,
    (SELECT sm.permissions FROM server_members sm WHERE sm.server_id = s.id AND sm.user_id = ?) as member_permissions
    FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id
    WHERE s.status != 'deleting' AND (s.owner_id = ? OR s.id IN (SELECT server_id FROM server_members WHERE user_id = ?))
    ORDER BY s.created_at DESC`).all(req.user.id, req.user.id, req.user.id, req.user.id);

  res.json(servers.map(s => ({
    ...s,
    port_mappings: JSON.parse(s.port_mappings),
    env_vars: JSON.parse(s.env_vars),
    secret_vars: JSON.parse(s.secret_vars || '[]').map(v => ({ key: v.key, value: null })),
    discord_config: s.discord_config ? JSON.parse(s.discord_config) : null,
    node_online: nodeManager.isOnline(s.node_id),
    shared: s.shared || 0,
    member_permissions: s.member_permissions || null,
  })));
});

// Must be before /:id to avoid Express matching 'transfers' as a server ID
router.get('/transfers/incoming', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.image, u.username as owner_name
    FROM servers s JOIN users u ON s.owner_id = u.id
    WHERE s.transfer_to_user_id = ?
  `).all(String(req.user.id));
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const server = db.prepare("SELECT s.*, u.username as owner_name, n.name as node_name, n.ip_address as node_ip_address FROM servers s JOIN users u ON s.owner_id = u.id JOIN nodes n ON s.node_id = n.id WHERE s.id = ? AND s.status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });

  let transfer_to_username = null;
  if (server.transfer_to_user_id) {
    const tu = db.prepare('SELECT username FROM users WHERE id = ?').get(server.transfer_to_user_id);
    transfer_to_username = tu?.username || null;
  }

  const member = getMember(server.id, req.user.id);
  res.json({
    ...server,
    port_mappings: JSON.parse(server.port_mappings),
    env_vars: JSON.parse(server.env_vars),
    secret_vars: JSON.parse(server.secret_vars || '[]').map(v => ({ key: v.key, value: null })),
    discord_config: server.discord_config ? JSON.parse(server.discord_config) : null,
    node_online: nodeManager.isOnline(server.node_id),
    member_permissions: member ? JSON.parse(member.permissions || '[]') : null,
    transfer_to_username,
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
  const { name, preset_id, node_id, image: chosenImage, setup_var_values } = req.body;
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

  // Validate chosen image (must be preset default or one of the preset's extra images)
  let finalImage = preset.image;
  if (chosenImage && chosenImage !== preset.image) {
    const allowed = JSON.parse(preset.images || '[]').map(i => i.image);
    if (!allowed.includes(chosenImage)) return res.status(400).json({ error: 'Invalid image selection' });
    finalImage = chosenImage;
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
  if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on this node. Ask an admin to expand the port range.' });
  const env_vars = JSON.parse(preset.env_vars);

  const installScript = preset.install_script || '';
  const preStartScript = preset.pre_start_script || '';

  // Merge user-supplied setup var values into the preset's env vars
  let finalEnvVars = JSON.parse(preset.env_vars || '[]');
  const setupVars = JSON.parse(preset.setup_vars || '[]');
  if (setup_var_values && typeof setup_var_values === 'object' && setupVars.length > 0) {
    const allowedKeys = new Set(setupVars.map(sv => sv.key));
    for (const [k, v] of Object.entries(setup_var_values)) {
      if (!allowedKeys.has(k)) continue;
      const idx = finalEnvVars.findIndex(e => e.key === k);
      if (idx >= 0) finalEnvVars[idx] = { key: k, value: String(v) };
      else finalEnvVars.push({ key: k, value: String(v) });
    }
  }

  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, enable_mods, enable_packages, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, preset.description, finalImage, finalNodeId, req.user.id, JSON.stringify(port_mappings), JSON.stringify(finalEnvVars), memoryLimit, preset.cpu_limit, diskLimit, preset.startup_command || '', installScript, preStartScript, preset.enable_mods ?? 1, preset.enable_packages ?? 1);

  log.info('server', `Installing "${name}" (${id.slice(0, 8)}) via preset "${preset.name}" on node ${finalNodeId.slice(0, 8)}`);
  nodeManager.send(finalNodeId, {
    type: 'install-server',
    serverId: id,
    image: finalImage,
    portMappings: port_mappings,
    envVars: finalEnvVars,
    memoryLimit: memoryLimit,
    cpuLimit: preset.cpu_limit,
    startupCommand: preset.startup_command || '',
    installScript,
  }).then(data => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s) return;
    if (s.status === 'deleting') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      nodeManager.send(finalNodeId, { type: 'delete-server', serverId: id, containerId: data.containerId }).catch(() => {});
      return;
    }
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
    log.ok('server', `"${name}" (${id.slice(0, 8)}) installed — container ${data.containerId?.slice(0, 12)}`);
  }).catch(err => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s || s.status === 'deleting') { db.prepare('DELETE FROM servers WHERE id = ?').run(id); return; }
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    log.error('server', `"${name}" (${id.slice(0, 8)}) install FAILED: ${err.message}`);
  });

  if (req.user.role !== 'admin') audit(req.user.id, id, 'server.create', { name, preset: preset.name, image: finalImage }, req);
  res.status(202).json({ id, status: 'installing', port_mappings });
});

router.post('/from-template', async (req, res) => {
  const { name, template_id, node_id } = req.body;
  if (!name || !template_id) return res.status(400).json({ error: 'name and template_id are required' });

  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(template_id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  if (req.user.role !== 'admin' && template.required_rank_id) {
    const canUse = (() => {
      const u = db.prepare('SELECT rank_id FROM users WHERE id = ?').get(req.user.id);
      if (!u?.rank_id) return false;
      const uRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(u.rank_id);
      const rRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(template.required_rank_id);
      return uRank && rRank && uRank.sort_order >= rRank.sort_order;
    })();
    if (!canUse) return res.status(403).json({ error: 'Your rank does not have access to this template' });
  }

  const memoryLimit = template.memory_limit;
  const diskLimit   = template.disk_limit || 0;

  const limitErr = checkAccountLimits(req.user.id, memoryLimit, diskLimit);
  if (limitErr) return res.status(403).json({ error: limitErr });

  const finalNodeId = findAvailableNode(node_id || null, memoryLimit, diskLimit);
  if (!finalNodeId) return res.status(503).json({ error: 'All nodes are full or offline. Try again later or ask an admin to add capacity.' });

  const id = uuidv4();
  const port_mappings = autoPortMappings(finalNodeId);
  if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on this node. Ask an admin to expand the port range.' });
  const env_vars = JSON.parse(template.env_vars || '[]');
  const files = JSON.parse(template.files || '[]');
  const installScript = template.install_script || '';
  const preStartScript = template.pre_start_script || '';

  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, enable_mods, enable_packages, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, template.description, template.image, finalNodeId, req.user.id, JSON.stringify(port_mappings), template.env_vars, memoryLimit, template.cpu_limit, diskLimit, template.startup_command || '', installScript, preStartScript, template.enable_mods ?? 1, template.enable_packages ?? 1);

  log.info('server', `Installing "${name}" (${id.slice(0, 8)}) via template "${template.name}" on node ${finalNodeId.slice(0, 8)}`);
  nodeManager.send(finalNodeId, {
    type: 'install-server',
    serverId: id,
    image: template.image,
    portMappings: port_mappings,
    envVars: env_vars,
    memoryLimit,
    cpuLimit: template.cpu_limit,
    startupCommand: template.startup_command || '',
    installScript,
  }).then(async data => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s) return;
    if (s.status === 'deleting') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      nodeManager.send(finalNodeId, { type: 'delete-server', serverId: id, containerId: data.containerId }).catch(() => {});
      return;
    }
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
    log.ok('server', `"${name}" (${id.slice(0, 8)}) installed — container ${data.containerId?.slice(0, 12)}`);
    if (files.length > 0) {
      try {
        await nodeManager.send(finalNodeId, { type: 'write-files', serverId: id, files }, { timeout: 30000 });
        log.info('server', `Wrote ${files.length} template file(s) to "${name}" (${id.slice(0, 8)})`);
      } catch (err) {
        log.error('server', `Failed to write template files to "${name}" (${id.slice(0, 8)}): ${err.message}`);
      }
    }
  }).catch(err => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s || s.status === 'deleting') { db.prepare('DELETE FROM servers WHERE id = ?').run(id); return; }
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    log.error('server', `"${name}" (${id.slice(0, 8)}) install FAILED: ${err.message}`);
  });

  if (req.user.role !== 'admin') audit(req.user.id, id, 'server.create', { name, template: template.name, image: template.image }, req);
  res.status(202).json({ id, status: 'installing', port_mappings });
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
  if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on this node. Ask an admin to expand the port range.' });

  const id = uuidv4();
  const startup_command = req.body.startup_command || '';
  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, description, image, actualNodeId, targetOwner, JSON.stringify(port_mappings), JSON.stringify(env_vars), memory_limit, cpu_limit, disk_limit_val, startup_command);

  log.info('server', `Installing "${name}" (${id.slice(0, 8)}) on node ${actualNodeId.slice(0, 8)} — image: ${image}`);
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
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s) return;
    if (s.status === 'deleting') {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      nodeManager.send(actualNodeId, { type: 'delete-server', serverId: id, containerId: data.containerId }).catch(() => {});
      return;
    }
    db.prepare(`UPDATE servers SET container_id = ?, status = 'stopped' WHERE id = ?`).run(data.containerId, id);
    log.ok('server', `"${name}" (${id.slice(0, 8)}) installed — container ${data.containerId?.slice(0, 12)}`);
  }).catch(err => {
    const s = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!s || s.status === 'deleting') { db.prepare('DELETE FROM servers WHERE id = ?').run(id); return; }
    db.prepare(`UPDATE servers SET status = 'error' WHERE id = ?`).run(id);
    log.error('server', `"${name}" (${id.slice(0, 8)}) install FAILED: ${err.message}`);
  });

  res.status(202).json({ id, status: 'installing' });
});

router.post('/:id/action', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    msg.preStartScript = server.pre_start_script || '';
    db.prepare('UPDATE servers SET terminal_mode = ? WHERE id = ?').run(terminalMode ? 1 : 0, server.id);
    const envVars = JSON.parse(server.env_vars);
    const secretVars = JSON.parse(server.secret_vars || '[]');
    msg.serverConfig = {
      image: server.image,
      portMappings: JSON.parse(server.port_mappings),
      envVars: [...envVars, ...secretVars],
      memoryLimit: server.memory_limit,
      cpuLimit: server.cpu_limit,
    };
  }

  // Respond immediately — Docker events + Socket.IO update the actual status
  res.json({ ok: true });

  if (req.user.role !== 'admin') audit(req.user.id, server.id, `power.${action}`, { action }, req);
  log.info('server', `"${server.name}" — ${action} by ${req.user.username || req.user.id}`);

  // Background: persist new container ID if daemon recreated the container
  nodeManager.send(server.node_id, msg).then(result => {
    if (result?.containerId && result.containerId !== server.container_id) {
      db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(result.containerId, server.id);
    }
  }).catch(err => {
    log.error('server', `${action} failed for "${server.name}" (${server.id.slice(0, 8)}): ${err.message}`);
  });
});

router.post('/:id/suspend', requireAdmin, async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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

// Wipe the committed container image so the next start uses the base image.
// Useful after changing the server's Docker image, or to recover from a bad system state.
router.post('/:id/reset-state', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (server.status === 'running') return res.status(400).json({ error: 'Stop the server before resetting its state' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Node is offline' });
  try {
    await nodeManager.send(server.node_id, { type: 'reset-saved-state', serverId: server.id });
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'server.reset_state', {}, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File manager ─────────────────────────────────────────────────────────────
function fileMsg(server, extra) {
  return { serverId: server.id, containerId: server.container_id, ...extra };
}

router.get('/:id/files', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.read', { path: filePath }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.get('/:id/files/read-binary', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  try {
    const result = await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'read-file-binary', path: filePath }));
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.read', { path: filePath }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.put('/:id/files/write', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.write', { path: filePath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/upload', express.raw({ type: '*/*', limit: '512mb' }), async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.upload', { path: filePath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/upload-chunk', express.raw({ type: '*/*', limit: '6mb' }), async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: filePath } = req.query;
  const offset = parseInt(req.query.offset, 10) || 0;
  const total = parseInt(req.query.total, 10) || 0;
  if (!filePath) return res.status(400).json({ error: 'path query param is required' });
  try {
    const content = req.body.toString('base64');
    const isLast = total === 0 || offset + req.body.length >= total;
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'write-file-chunk', path: filePath, content, encoding: 'base64', offset, isLast }));
    if (isLast && req.user.role !== 'admin') audit(req.user.id, server.id, 'file.upload', { path: filePath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/mkdir', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.mkdir', { path: dirPath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.delete('/:id/files', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.delete', { path: filePath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { url, branch, folder, path: targetPath, username, token } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!/^https:\/\/.+/.test(url)) return res.status(400).json({ error: 'Only https:// URLs are supported' });
  let parsed;
  try {
    parsed = new URL(url);
    if (/^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fd[0-9a-f]{2}:)/i.test(parsed.hostname)) {
      return res.status(400).json({ error: 'Private or loopback URLs are not allowed' });
    }
    // Block decimal-encoded IPs (e.g. 2130706433 = 127.0.0.1) — no public URL uses a pure-integer hostname
    if (/^\d+$/.test(parsed.hostname)) {
      return res.status(400).json({ error: 'Private or loopback URLs are not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  let authedUrl = url;
  if (username && token) {
    parsed.username = encodeURIComponent(username);
    parsed.password = encodeURIComponent(token);
    authedUrl = parsed.toString();
  }
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'git-clone', url: authedUrl, branch: branch || '', folder: folder || '', path: targetPath || '/home/container' }),
      { timeout: 300000 }
    );
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.git_clone', { url, branch: branch || null }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git-pull', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: targetPath, strategy, username, token } = req.body;
  const validStrategies = ['ff-only', 'merge', 'rebase'];
  const pullStrategy = validStrategies.includes(strategy) ? strategy : 'ff-only';
  let authedUrl = null;
  if (username && token) {
    try {
      const remoteInfo = await nodeManager.send(
        server.node_id,
        fileMsg(server, { type: 'git-remote-url', path: targetPath || '/home/container' }),
        { timeout: 10000 }
      ).catch(() => null);
      const remoteUrl = remoteInfo?.url;
      if (remoteUrl && /^https:\/\//i.test(remoteUrl)) {
        const p = new URL(remoteUrl);
        p.username = encodeURIComponent(username);
        p.password = encodeURIComponent(token);
        authedUrl = p.toString();
      }
    } catch { /* fall back to unauthenticated pull */ }
  }
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'git-pull', path: targetPath || '/home/container', strategy: pullStrategy, ...(authedUrl ? { authedUrl } : {}) }),
      { timeout: 300000 }
    );
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.git_pull', { strategy: pullStrategy }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/git-reset', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.git_reset', { commit: commit || 'HEAD~1', mode: resetMode }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/extract', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });
  const { path: archivePath, dest } = req.body;
  if (!archivePath) return res.status(400).json({ error: 'path is required' });
  try {
    const result = await nodeManager.send(
      server.node_id,
      fileMsg(server, { type: 'extract-archive', path: archivePath, dest: dest || null }),
      { timeout: 120000 }
    );
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.extract', { path: archivePath }, req);
    res.json(result);
  } catch (err) { sendFileError(res, err); }
});

router.post('/:id/files/rename', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'file.rename', { from: oldPath, to: newPath }, req);
    res.json({ ok: true });
  } catch (err) { sendFileError(res, err); }
});

// ── Modrinth mod/plugin install ───────────────────────────────────────────────
function downloadFromCDN(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const MAX = 500 * 1024 * 1024;
    https.get(url, { timeout: 120000 }, resp => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        return downloadFromCDN(resp.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error(`CDN returned HTTP ${resp.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      resp.on('data', chunk => {
        size += chunk.length;
        if (size > MAX) { resp.destroy(); return reject(new Error('File too large (max 500 MB)')); }
        chunks.push(chunk);
      });
      resp.on('end',   () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Download timed out')));
  });
}

router.post('/:id/mods/install', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'files')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr = suspendedBlock(server, req.user); if (suspErr) return res.status(suspErr.status).json({ error: suspErr.error });
  const accessError = fileAccessError(server);
  if (accessError) return res.status(accessError.status).json({ error: accessError.error });

  const { url, filename, installPath } = req.body;

  if (!url || !url.startsWith('https://cdn.modrinth.com/')) {
    return res.status(400).json({ error: 'Only Modrinth CDN URLs are allowed' });
  }
  const safeFilename = String(filename || '').replace(/[/\\]/g, '').replace(/\.{2,}/g, '.');
  if (!safeFilename || safeFilename.length > 200) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (!installPath || typeof installPath !== 'string' || !installPath.startsWith('/') || installPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid install path' });
  }

  try {
    const buf = await downloadFromCDN(url);
    const content = buf.toString('base64');
    const filePath = installPath.replace(/\/+$/, '') + '/' + safeFilename;
    await nodeManager.send(server.node_id,
      fileMsg(server, { type: 'write-file', path: filePath, content, encoding: 'base64' }));
    audit(req.user.id, server.id, 'file.upload', { path: filePath, via: 'modrinth' }, req);
    res.json({ ok: true, path: filePath });
  } catch (err) { sendFileError(res, err); }
});

router.patch('/:id/settings', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'settings')) return res.status(403).json({ error: 'Forbidden' });
  const suspErr2 = suspendedBlock(server, req.user); if (suspErr2) return res.status(suspErr2.status).json({ error: suspErr2.error });
  const { name, description, startup_command, pre_start_script, disk_limit, memory_limit, cpu_limit, discord_webhook, discord_config, env_vars, secret_vars, enable_mods, enable_packages } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) {
    const trimmed = String(name).trim().slice(0, 100);
    if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.push('name = ?'); values.push(trimmed);
  }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (startup_command !== undefined) { updates.push('startup_command = ?'); values.push(startup_command); }
  if (pre_start_script !== undefined) { updates.push('pre_start_script = ?'); values.push(String(pre_start_script || '')); }
  if (disk_limit !== undefined && req.user.role === 'admin') { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (memory_limit !== undefined && req.user.role === 'admin') { updates.push('memory_limit = ?'); values.push(Math.max(64, parseInt(memory_limit) || 512)); }
  if (cpu_limit    !== undefined && req.user.role === 'admin') { updates.push('cpu_limit = ?'); values.push(Math.max(0.1, Number.isFinite(parseFloat(cpu_limit)) ? parseFloat(cpu_limit) : 1.0)); }
  if (discord_webhook !== undefined) {
    const url = discord_webhook?.trim() || null;
    if (url && !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url)) {
      return res.status(400).json({ error: 'Invalid Discord webhook URL' });
    }
    updates.push('discord_webhook = ?');
    values.push(url);
  }
  if (env_vars !== undefined && Array.isArray(env_vars)) {
    const sanitized = env_vars
      .filter(e => e.key && String(e.key).trim())
      .map(e => ({ key: String(e.key).trim().slice(0, 256), value: String(e.value ?? '').slice(0, 4096) }))
      .filter(e => e.key);
    updates.push('env_vars = ?');
    values.push(JSON.stringify(sanitized));
  }
  if (secret_vars !== undefined && Array.isArray(secret_vars)) {
    const existing = JSON.parse(server.secret_vars || '[]');
    const existingMap = Object.fromEntries(existing.map(e => [e.key, e.value]));
    const sanitized = secret_vars
      .filter(e => e.key && String(e.key).trim())
      .map(e => {
        const key = String(e.key).trim().slice(0, 256);
        // Empty value means "keep existing" — look up the stored value
        const value = (e.value === '' || e.value == null) && key in existingMap
          ? existingMap[key]
          : String(e.value ?? '');
        return { key, value };
      });
    updates.push('secret_vars = ?');
    values.push(JSON.stringify(sanitized));
  }
  if (enable_mods !== undefined) { updates.push('enable_mods = ?'); values.push(enable_mods ? 1 : 0); }
  if (enable_packages !== undefined) { updates.push('enable_packages = ?'); values.push(enable_packages ? 1 : 0); }
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
  const changedFields = updates.map(u => u.split(' = ')[0]);
  if (req.user.role !== 'admin') audit(req.user.id, server.id, 'server.settings', { changed: changedFields }, req);
  const updated = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  res.json({ ...updated, port_mappings: JSON.parse(updated.port_mappings), env_vars: JSON.parse(updated.env_vars), secret_vars: JSON.parse(updated.secret_vars || '[]').map(v => ({ key: v.key, value: null })), discord_config: updated.discord_config ? JSON.parse(updated.discord_config) : null });
});

router.delete('/:id', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const suspErr3 = suspendedBlock(server, req.user); if (suspErr3) return res.status(suspErr3.status).json({ error: suspErr3.error });

  if (req.user.role !== 'admin') audit(req.user.id, server.id, 'server.delete', { name: server.name }, req);
  log.warn('server', `"${server.name}" (${server.id.slice(0, 8)}) deleted by ${req.user.username || req.user.id}`);
  db.prepare("UPDATE servers SET status = 'deleting' WHERE id = ?").run(server.id);
  emitServerDeleted(server);

  if (!nodeManager.isOnline(server.node_id) || !server.container_id) {
    // Node offline or no container yet — just wipe the DB row immediately
    db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
  } else {
    await nodeManager.send(server.node_id, {
      type: 'delete-server',
      serverId: server.id,
      containerId: server.container_id,
    }).catch(() => {});
    db.prepare("DELETE FROM servers WHERE id = ? AND status = 'deleting'").run(server.id);
  }

  res.json({ ok: true });
});

router.post('/:id/stdin', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'console.command', { command: data.slice(0, 200) }, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/packages', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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
    if (req.user.role !== 'admin') audit(req.user.id, server.id, 'package.install', { manager, pkg: isManifestInstall ? '(manifest)' : pkg.trim() }, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/stats', async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
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

// ── Server activity log ───────────────────────────────────────────────────────

router.get('/:id/activity', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canAccess(server, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const limit  = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

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
  });
});

// ── Server members ─────────────────────────────────────────────────────────

router.get('/:id/members', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const members = db.prepare(`SELECT sm.user_id, sm.permissions, sm.created_at, u.username, u.email, u.avatar
    FROM server_members sm JOIN users u ON sm.user_id = u.id
    WHERE sm.server_id = ? ORDER BY sm.created_at ASC`).all(req.params.id);
  res.json(members.map(m => ({ ...m, permissions: JSON.parse(m.permissions || '[]') })));
});

router.post('/:id/members', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { username, permissions } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const validPerms = ['console', 'files', 'settings', 'power', 'sharelog', 'sharefile'];
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
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const validPerms = ['console', 'files', 'settings', 'power', 'sharelog', 'sharefile'];
  const perms = Array.isArray(req.body.permissions) ? req.body.permissions.filter(p => validPerms.includes(p)) : [];
  const result = db.prepare('UPDATE server_members SET permissions = ? WHERE server_id = ? AND user_id = ?')
    .run(JSON.stringify(perms), req.params.id, req.params.userId);
  if (!result.changes) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json({ ok: true });
});

router.post('/:id/leave', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const member = getMember(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Transfer ownership ────────────────────────────────────────────────────────

// Owner or admin initiates a pending transfer — target user must accept
router.post('/:id/transfer', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.prepare('SELECT id, role, rank_id FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === server.owner_id) return res.status(400).json({ error: 'User already owns this server' });
  if (target.role !== 'admin') {
    const targetRank = target.rank_id ? db.prepare('SELECT max_servers FROM ranks WHERE id = ?').get(target.rank_id) : null;
    const maxServers = targetRank ? targetRank.max_servers : 1;
    if (maxServers !== -1) {
      const { count } = db.prepare("SELECT COUNT(*) as count FROM servers WHERE owner_id = ? AND status != 'deleting'").get(String(target.id));
      if (count >= maxServers) return res.status(400).json({ error: `${username} is at their server limit (${maxServers})` });
    }
  }
  db.prepare('UPDATE servers SET transfer_to_user_id = ? WHERE id = ?').run(String(target.id), req.params.id);
  res.json({ ok: true });
});

// Owner or admin cancels a pending transfer
router.delete('/:id/transfer', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && server.owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE servers SET transfer_to_user_id = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Target user accepts the transfer
router.post('/:id/transfer/accept', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (server.transfer_to_user_id !== String(req.user.id)) return res.status(403).json({ error: 'No pending transfer for you on this server' });
  if (req.user.role !== 'admin') {
    const me = db.prepare('SELECT rank_id FROM users WHERE id = ?').get(req.user.id);
    const myRank = me?.rank_id ? db.prepare('SELECT max_servers FROM ranks WHERE id = ?').get(me.rank_id) : null;
    const maxServers = myRank ? myRank.max_servers : 1;
    if (maxServers !== -1) {
      const { count } = db.prepare("SELECT COUNT(*) as count FROM servers WHERE owner_id = ? AND status != 'deleting'").get(String(req.user.id));
      if (count >= maxServers) return res.status(400).json({ error: 'You are at your server limit and cannot accept this transfer' });
    }
  }
  const oldOwnerId = server.owner_id;
  db.prepare('UPDATE servers SET owner_id = ?, transfer_to_user_id = NULL WHERE id = ?').run(req.user.id, req.params.id);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  const io = nodeManager.io;
  if (io) io.to(`user:${oldOwnerId}`).emit('server-deleted', { serverId: req.params.id });
  res.json({ ok: true });
});

// Target user declines the transfer
router.post('/:id/transfer/decline', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (server.transfer_to_user_id !== String(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ error: 'No pending transfer for you on this server' });
  db.prepare('UPDATE servers SET transfer_to_user_id = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Log shares ────────────────────────────────────────────────────────────────

const LOG_SHARE_MAX_BYTES    = 512 * 1024;
const LOG_SHARE_MAX_TTL_SECS = 7 * 24 * 3600;

function canManageLogShares(server, user) {
  return hasPerm(server, user, 'sharelog');
}

router.get('/:id/log-shares', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canManageLogShares(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const now = Math.floor(Date.now() / 1000);
  const shares = db.prepare('SELECT id, label, view_count, created_at, expires_at FROM log_shares WHERE server_id = ? AND expires_at > ? ORDER BY created_at DESC')
    .all(req.params.id, now);
  res.json(shares);
});

router.post('/:id/log-shares', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canManageLogShares(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { content, label, ttl_seconds } = req.body;
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  if (Buffer.byteLength(content, 'utf8') > LOG_SHARE_MAX_BYTES) return res.status(400).json({ error: 'Log too large (max 512 KB)' });
  const ttl = Math.min(Math.max(parseInt(ttl_seconds) || LOG_SHARE_MAX_TTL_SECS, 3600), LOG_SHARE_MAX_TTL_SECS);
  const now = Math.floor(Date.now() / 1000);
  const activeCount = db.prepare('SELECT COUNT(*) as n FROM log_shares WHERE server_id = ? AND expires_at > ?').get(req.params.id, now)?.n ?? 0;
  if (activeCount >= 5) return res.status(400).json({ error: 'Limit reached: max 5 active log shares per server. Delete one first.' });
  const id = crypto.randomBytes(10).toString('hex');
  db.prepare('INSERT INTO log_shares (id, server_id, label, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, label || null, content, now, now + ttl);
  res.json({ id, expires_at: now + ttl });
});

router.delete('/:id/log-shares/:shareId', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!canManageLogShares(server, req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM log_shares WHERE id = ? AND server_id = ?').run(req.params.shareId, req.params.id);
  res.json({ ok: true });
});

// ── File shares ───────────────────────────────────────────────────────────────

const FILE_SHARE_MAX_BYTES    = 512 * 1024;
const FILE_SHARE_MAX_TTL_SECS = 7 * 24 * 3600;

router.get('/:id/file-shares', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'sharefile')) return res.status(403).json({ error: 'Forbidden' });
  const now = Math.floor(Date.now() / 1000);
  const shares = db.prepare('SELECT id, label, file_path, language, view_count, created_at, expires_at FROM file_shares WHERE server_id = ? AND expires_at > ? ORDER BY created_at DESC')
    .all(req.params.id, now);
  res.json(shares);
});

router.post('/:id/file-shares', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'sharefile')) return res.status(403).json({ error: 'Forbidden' });
  const { content, label, file_path, language, ttl_seconds } = req.body;
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  if (Buffer.byteLength(content, 'utf8') > FILE_SHARE_MAX_BYTES) return res.status(400).json({ error: 'File too large (max 512 KB)' });
  const ttl = Math.min(Math.max(parseInt(ttl_seconds) || FILE_SHARE_MAX_TTL_SECS, 3600), FILE_SHARE_MAX_TTL_SECS);
  const now = Math.floor(Date.now() / 1000);
  const activeCount = db.prepare('SELECT COUNT(*) as n FROM file_shares WHERE server_id = ? AND expires_at > ?').get(req.params.id, now)?.n ?? 0;
  if (activeCount >= 10) return res.status(400).json({ error: 'Limit reached: max 10 active file shares per server. Delete one first.' });
  const id = crypto.randomBytes(10).toString('hex');
  db.prepare('INSERT INTO file_shares (id, server_id, label, file_path, content, language, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, label || null, file_path || null, content, language || null, now, now + ttl);
  res.json({ id, expires_at: now + ttl });
});

router.delete('/:id/file-shares/:shareId', (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!hasPerm(server, req.user, 'sharefile')) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM file_shares WHERE id = ? AND server_id = ?').run(req.params.shareId, req.params.id);
  res.json({ ok: true });
});

// ── Node migration (admin only) ───────────────────────────────────────────────

router.post('/:id/migrate', requireAdmin, async (req, res) => {
  const server = db.prepare("SELECT * FROM servers WHERE id = ? AND status != 'deleting'").get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });

  const { node_id: targetNodeId } = req.body;
  if (!targetNodeId) return res.status(400).json({ error: 'node_id is required' });
  if (targetNodeId === server.node_id) return res.status(400).json({ error: 'Server is already on this node' });

  const targetNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(targetNodeId);
  if (!targetNode) return res.status(404).json({ error: 'Target node not found' });
  if (!nodeManager.isOnline(targetNodeId)) return res.status(503).json({ error: 'Target node is offline' });
  if (!nodeManager.isOnline(server.node_id)) return res.status(503).json({ error: 'Source node is offline — bring it online first so files can be exported' });

  if (server.status === 'installing') return res.status(400).json({ error: 'Cannot migrate a server that is still installing' });
  if (server.status === 'running') return res.status(400).json({ error: 'Stop the server before migrating' });

  const capacityErr = checkNodeCapacity(targetNodeId, server.memory_limit, server.disk_limit || 0);
  if (capacityErr) return res.status(400).json({ error: capacityErr });

  try {
    // 1. Export data dir + saved container image from old node
    const exportResult = await nodeManager.send(server.node_id, {
      type: 'export-server', serverId: server.id,
    }, { timeout: 600000 });
    const exportedData      = exportResult?.data      || null;
    const exportedImageData = exportResult?.imageData || null;

    // 2. Remove old container + data dir + saved image from old node
    await nodeManager.send(server.node_id, {
      type: 'delete-server', serverId: server.id, containerId: server.container_id || null,
    }, { timeout: 30000 }).catch(() => {});

    // 3. Import data dir + saved container image into new node
    if (exportedData || exportedImageData) {
      await nodeManager.send(targetNodeId, {
        type: 'import-server',
        serverId: server.id,
        data: exportedData,
        imageData: exportedImageData,
      }, { timeout: 600000 });
    }

    // 4. Assign fresh port on target node and update DB
    const port_mappings = autoPortMappings(targetNodeId);
    if (port_mappings.length === 0) return res.status(503).json({ error: 'No free ports available on the target node. Ask an admin to expand the port range.' });
    db.prepare('UPDATE servers SET node_id = ?, port_mappings = ?, container_id = NULL, status = ? WHERE id = ?')
      .run(targetNodeId, JSON.stringify(port_mappings), 'stopped', server.id);

    res.json({ ok: true, port_mappings, node_name: targetNode.name, files_transferred: !!exportedData, image_transferred: !!exportedImageData });
  } catch (err) {
    res.status(500).json({ error: `Migration failed: ${err.message}` });
  }
});

module.exports = router;
