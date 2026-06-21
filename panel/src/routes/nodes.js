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

  const id = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');

  db.prepare(`INSERT INTO nodes (id, name, description, token, memory, cpu, disk_limit, port_range_start, port_range_end, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, description || '', token, memory, cpu, Math.max(0, parseInt(disk_limit) || 0), parseInt(port_range_start) || 10000, parseInt(port_range_end) || 30000, ip_address || '');

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
  if (memory !== undefined) { updates.push('memory = ?'); values.push(Math.max(0, parseInt(memory) || 0)); }
  if (cpu !== undefined) { updates.push('cpu = ?'); values.push(Math.max(0, parseInt(cpu) || 0)); }
  if (disk_limit !== undefined) { updates.push('disk_limit = ?'); values.push(Math.max(0, parseInt(disk_limit) || 0)); }
  if (port_range_start !== undefined) { updates.push('port_range_start = ?'); values.push(Math.max(1024, parseInt(port_range_start) || 10000)); }
  if (port_range_end !== undefined) { updates.push('port_range_end = ?'); values.push(Math.min(65535, parseInt(port_range_end) || 30000)); }
  if (ip_address !== undefined) { updates.push('ip_address = ?'); values.push(ip_address || ''); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  const rangeChanged = port_range_start !== undefined || port_range_end !== undefined;
  values.push(req.params.id);
  db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updatedNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);

  // If the port range changed, reassign any server ports that now fall outside it
  let portsReassigned = 0;
  if (rangeChanged) {
    const { port_range_start: rangeStart, port_range_end: rangeEnd } = updatedNode;
    const servers = db.prepare('SELECT id, port_mappings FROM servers WHERE node_id = ?').all(req.params.id);

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
        needsReassign.push({ id: s.id, mappings });
      }
    }

    // Second pass: assign new in-range ports to out-of-range servers
    for (const s of needsReassign) {
      let newPort = null;
      for (let p = rangeStart; p <= rangeEnd; p++) {
        if (!portsInUse.has(p)) { newPort = p; break; }
      }
      if (!newPort) break; // range is full
      portsInUse.add(newPort);
      const newMappings = s.mappings.map(m => ({ ...m, hostPort: newPort, containerPort: newPort }));
      db.prepare('UPDATE servers SET port_mappings = ? WHERE id = ?').run(JSON.stringify(newMappings), s.id);
      portsReassigned++;
    }
  }

  res.json({ ...updatedNode, ports_reassigned: portsReassigned });
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

// Regenerate token
router.post('/:id/reset-token', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare('UPDATE nodes SET token = ? WHERE id = ?').run(token, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ token });
});

module.exports = router;
