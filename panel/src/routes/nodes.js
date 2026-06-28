const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const nodeManager = require('../nodeManager');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all();
  const isAdmin = req.user.role === 'admin';
  res.json(nodes.map(n => {
    const alloc = db.prepare(`
      SELECT COALESCE(SUM(memory_limit), 0) as used_memory,
             COALESCE(SUM(CASE WHEN disk_limit > 0 THEN disk_limit ELSE 0 END), 0) as used_disk,
             COUNT(*) as server_count
      FROM servers WHERE node_id = ?
    `).get(n.id);
    const base = {
      id: n.id, name: n.name, description: n.description || '',
      online: nodeManager.isOnline(n.id),
      memory: n.memory, cpu: n.cpu, disk_limit: n.disk_limit,
      port_range_start: n.port_range_start, port_range_end: n.port_range_end,
      used_memory: alloc?.used_memory ?? 0,
      used_disk:   alloc?.used_disk   ?? 0,
      server_count: alloc?.server_count ?? 0,
    };
    if (!isAdmin) return base;
    return { ...n, ...base };
  }));
});

router.get('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  res.json({ ...node, online: nodeManager.isOnline(node.id) });
});

router.post('/', requireAdmin, (req, res) => {
  const { name, description, memory = 4096, cpu = 4, disk_limit = 0, port_range_start = 10000, port_range_end = 30000, ip_address = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const rangeStart = Math.max(1024, Math.min(65534, parseInt(port_range_start) || 10000));
  const rangeEnd   = Math.max(1025, Math.min(65535, parseInt(port_range_end)   || 30000));
  if (rangeStart >= rangeEnd) return res.status(400).json({ error: 'port_range_start must be less than port_range_end' });

  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');

  db.prepare(`INSERT INTO nodes (id, name, description, token, memory, cpu, disk_limit, port_range_start, port_range_end, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, description || '', token,
      Math.max(64, parseInt(memory) || 4096),
      Math.max(0.1, parseFloat(cpu) || 4),
      Math.max(0, parseInt(disk_limit) || 0),
      rangeStart, rangeEnd, ip_address || '');

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  res.status(201).json(node);
});

router.patch('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const { name, description, memory, cpu, disk_limit, port_range_start, port_range_end, ip_address } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name.trim() || node.name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (memory !== undefined) { updates.push('memory = ?'); values.push(Math.max(64, parseInt(memory) || 64)); }
  if (cpu !== undefined) { updates.push('cpu = ?'); values.push(Math.max(0.1, parseFloat(cpu) || 0.1)); }
  if (disk_limit !== undefined) { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (port_range_start !== undefined) { updates.push('port_range_start = ?'); values.push(Math.max(1024, Math.min(65534, parseInt(port_range_start) || 10000))); }
  if (port_range_end !== undefined) { updates.push('port_range_end = ?'); values.push(Math.max(1025, Math.min(65535, parseInt(port_range_end) || 30000))); }
  if (ip_address !== undefined) { updates.push('ip_address = ?'); values.push(ip_address || ''); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  const rangeChanged = port_range_start !== undefined || port_range_end !== undefined;

  // Cross-validate port range using the would-be new values (falling back to current node values)
  if (rangeChanged) {
    const newStart = port_range_start !== undefined ? Math.max(1024, Math.min(65534, parseInt(port_range_start) || 10000)) : node.port_range_start;
    const newEnd   = port_range_end   !== undefined ? Math.max(1025, Math.min(65535, parseInt(port_range_end)   || 30000)) : node.port_range_end;
    if (newStart >= newEnd) return res.status(400).json({ error: 'port_range_start must be less than port_range_end' });
  }

  values.push(req.params.id);
  db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updatedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);

  // If the port range changed, reassign any server ports that now fall outside it
  let portsReassigned = 0;
  let serversRestarted = 0;
  if (rangeChanged) {
    const { port_range_start: rangeStart, port_range_end: rangeEnd } = updatedNode;
    const servers = db.prepare('SELECT id, port_mappings, status, container_id, image, env_vars, memory_limit, cpu_limit, startup_command FROM servers WHERE node_id = ?').all(req.params.id);

    // First pass: collect ports that are already in range (don't touch them)
    const portsInUse = new Set();
    const needsReassign = [];
    for (const s of servers) {
      let mappings;
      try { mappings = JSON.parse(s.port_mappings); } catch { mappings = []; }
      const hostPort = mappings[0]?.hostPort;
      if (!hostPort) continue;
      if (hostPort >= rangeStart && hostPort <= rangeEnd) {
        portsInUse.add(Number(hostPort));
      } else {
        needsReassign.push({ ...s, mappings });
      }
    }

    // Second pass: assign new in-range ports and collect which were running
    const toRestart = [];
    for (const s of needsReassign) {
      let newPort = null;
      for (let p = rangeStart; p <= rangeEnd; p++) {
        if (!portsInUse.has(p)) { newPort = p; break; }
      }
      if (newPort === null) { console.warn(`[nodes] Port range full — could not reassign server ${s.id}`); continue; }
      portsInUse.add(newPort);
      const newMappings = s.mappings.map(m => ({ ...m, hostPort: newPort, containerPort: newPort }));
      db.prepare('UPDATE servers SET port_mappings = ? WHERE id = ?').run(JSON.stringify(newMappings), s.id);
      portsReassigned++;
      if (s.status === 'running') toRestart.push({ ...s, newMappings });
    }

    // Background: restart running servers so Docker picks up the new port binding
    if (nodeManager.isOnline(req.params.id)) {
      for (const s of toRestart) {
        serversRestarted++;
        const msg = {
          type: 'server-action',
          serverId: s.id,
          containerId: s.container_id,
          action: 'start',
          startupCommand: s.startup_command || '',
          serverConfig: {
            image: s.image,
            portMappings: s.newMappings,
            envVars: JSON.parse(s.env_vars),
            memoryLimit: s.memory_limit,
            cpuLimit: s.cpu_limit,
          },
        };
        nodeManager.send(s.node_id || req.params.id, msg).then(result => {
          if (result?.containerId && result.containerId !== s.container_id) {
            db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(result.containerId, s.id);
          }
        }).catch(err => {
          console.error(`[port-reassign] restart failed for ${s.id}:`, err.message);
        });
      }
    }
  }

  res.json({ ...updatedNode, ports_reassigned: portsReassigned, servers_restarted: serversRestarted });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });

  const serverCount = db.prepare('SELECT COUNT(*) as count FROM servers WHERE node_id = ?').get(req.params.id);
  if (serverCount.count > 0) {
    return res.status(400).json({ error: 'Cannot delete node with active servers' });
  }

  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Live node system stats (CPU %, system RAM)
router.get('/:id/stats', async (req, res) => {
  const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!nodeManager.isOnline(node.id)) return res.status(503).json({ error: 'offline' });
  try {
    const result = await nodeManager.send(node.id, { type: 'node-stats' }, { timeout: 5000 });
    res.json(result);
  } catch {
    res.status(503).json({ error: 'timeout' });
  }
});


// Ping node — measures WebSocket round-trip latency in ms
router.get('/:id/ping', async (req, res) => {
  const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!nodeManager.isOnline(node.id)) return res.status(503).json({ error: 'offline' });
  const start = Date.now();
  try {
    await nodeManager.send(node.id, { type: 'ping' }, { timeout: 5000 });
    res.json({ ping: Date.now() - start });
  } catch {
    res.status(503).json({ error: 'timeout' });
  }
});

// Update daemon (git pull + restart)
router.post('/:id/update', requireAdmin, async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!nodeManager.isOnline(node.id)) return res.status(503).json({ error: 'Node is offline' });
  try {
    const result = await nodeManager.send(node.id, { type: 'update-daemon' }, { timeout: 90000 });
    res.json({ ok: true, output: result.output || 'Already up to date.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk action on all servers on a node
router.post('/:id/action-all', requireAdmin, async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!nodeManager.isOnline(node.id)) return res.status(503).json({ error: 'Node is offline' });

  const { action } = req.body;
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'action must be start, stop, or restart' });

  const statusFilter = action === 'start' ? "= 'stopped'" : "= 'running'";
  const servers = db.prepare(
    `SELECT * FROM servers WHERE node_id = ? AND status ${statusFilter} AND suspended = 0`
  ).all(node.id);

  let sent = 0;
  const errors = [];
  await Promise.all(servers.map(async s => {
    const portMappings = (() => { try { return JSON.parse(s.port_mappings); } catch { return []; } })();
    const envVars      = (() => { try { return JSON.parse(s.env_vars);      } catch { return []; } })();
    const msg = {
      type: 'server-action',
      serverId: s.id,
      containerId: s.container_id,
      action,
      startupCommand: s.startup_command || '',
      serverConfig: {
        image: s.image,
        portMappings,
        envVars,
        memoryLimit: s.memory_limit,
        cpuLimit: s.cpu_limit,
      },
    };
    try {
      const result = await nodeManager.send(node.id, msg);
      if (result?.containerId && result.containerId !== s.container_id) {
        db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(result.containerId, s.id);
      }
      sent++;
    } catch (e) {
      errors.push({ id: s.id, name: s.name, error: e.message });
    }
  }));

  res.json({ ok: true, sent, skipped: servers.length - sent - errors.length, errors });
});

// Regenerate token
router.post('/:id/reset-token', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare('UPDATE nodes SET token = ? WHERE id = ?').run(token, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ token });
});

module.exports = router;
