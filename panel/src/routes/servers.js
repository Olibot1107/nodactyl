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

router.post('/', requireAdmin, async (req, res) => {
  const {
    name, description = '', image, node_id, owner_id,
    port_mappings = [], env_vars = [],
    memory_limit = 512, cpu_limit = 1.0,
  } = req.body;

  if (!name || !image || !node_id) return res.status(400).json({ error: 'name, image, and node_id are required' });
  if (!nodeManager.isOnline(node_id)) return res.status(503).json({ error: 'Node is offline' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node_id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const targetOwner = owner_id || req.user.id;
  const id = uuidv4();

  db.prepare(`INSERT INTO servers (id, name, description, image, node_id, owner_id, port_mappings, env_vars, memory_limit, cpu_limit, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing')`)
    .run(id, name, description, image, node_id, targetOwner, JSON.stringify(port_mappings), JSON.stringify(env_vars), memory_limit, cpu_limit);

  // Send install command to daemon — async, don't block response
  nodeManager.send(node_id, {
    type: 'install-server',
    serverId: id,
    image,
    portMappings: port_mappings,
    envVars: env_vars,
    memoryLimit: memory_limit,
    cpuLimit: cpu_limit,
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
  const validActions = ['start', 'stop', 'restart', 'kill'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    await nodeManager.send(server.node_id, {
      type: 'server-action',
      serverId: server.id,
      containerId: server.container_id,
      action,
    });

    const newStatus = (action === 'start' || action === 'restart') ? 'running' : 'stopped';
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(newStatus, server.id);
    res.json({ ok: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
