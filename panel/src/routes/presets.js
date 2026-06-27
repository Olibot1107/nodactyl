const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function parsePreset(p) {
  return { ...p, port_mappings: JSON.parse(p.port_mappings), env_vars: JSON.parse(p.env_vars), images: JSON.parse(p.images || '[]'), setup_vars: JSON.parse(p.setup_vars || '[]') };
}

function canUsePreset(preset, user) {
  if (user.role === 'admin') return true;
  if (!preset.required_rank_id) return true;
  if (!user.rank_id) return false;
  const userRank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(user.rank_id);
  const reqRank  = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(preset.required_rank_id);
  if (!userRank || !reqRank) return false;
  return userRank.sort_order >= reqRank.sort_order;
}

router.get('/', (req, res) => {
  const presets = db.prepare('SELECT * FROM presets ORDER BY name ASC').all();
  const visible = req.user.role === 'admin'
    ? presets
    : presets.filter(p => canUsePreset(p, req.user));
  res.json(visible.map(parsePreset));
});

function presetToExportShape(p) {
  return {
    name: p.name,
    description: p.description || '',
    image: p.image,
    images: JSON.parse(p.images || '[]'),
    env_vars: JSON.parse(p.env_vars || '[]'),
    setup_vars: JSON.parse(p.setup_vars || '[]'),
    memory_limit: p.memory_limit,
    cpu_limit: p.cpu_limit,
    disk_limit: p.disk_limit || 0,
    startup_command: p.startup_command || '',
    install_script: p.install_script || '',
    pre_start_script: p.pre_start_script || '',
  };
}

// Export a single preset by ID
router.get('/:id/export', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const safeName = p.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  res.setHeader('Content-Disposition', `attachment; filename="preset-${safeName}.json"`);
  res.json({ version: 1, exported_at: new Date().toISOString(), presets: [presetToExportShape(p)] });
});

router.post('/import', requireAdmin, (req, res) => {
  const list = req.body?.presets;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: 'Body must have a non-empty presets array' });
  let imported = 0;
  const errors = [];
  for (const p of list) {
    if (!p.name || !p.image) { errors.push(`Skipped entry: missing name or image`); continue; }
    const id = uuidv4();
    try {
      const safeImages = Array.isArray(p.images) ? p.images.filter(i => i?.label && i?.image) : [];
      const safeSetupVars = Array.isArray(p.setup_vars) ? p.setup_vars.filter(sv => sv?.key && sv?.label) : [];
      db.prepare(`INSERT INTO presets (id, name, description, image, images, port_mappings, env_vars, setup_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, required_rank_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(id, String(p.name).trim(), String(p.description || ''), String(p.image).trim(),
          JSON.stringify(safeImages), '[]',
          JSON.stringify(Array.isArray(p.env_vars) ? p.env_vars : []),
          JSON.stringify(safeSetupVars),
          p.memory_limit || 512, p.cpu_limit || 1.0,
          Math.max(0, parseInt(p.disk_limit) || 0),
          p.startup_command || '', p.install_script || '', p.pre_start_script || '');
      imported++;
    } catch (err) {
      errors.push(`Failed "${p.name}": ${err.message}`);
    }
  }
  res.json({ ok: true, imported, errors });
});

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!canUsePreset(p, req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json(parsePreset(p));
});

router.post('/', requireAdmin, (req, res) => {
  const { name, description = '', image, images = [], port_mappings = [], env_vars = [], setup_vars = [], memory_limit = 512, cpu_limit = 1.0, disk_limit = 0, startup_command = '', install_script = '', pre_start_script = '', required_rank_id = null } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image are required' });
  const safeImages    = Array.isArray(images)     ? images.filter(i => i && typeof i.label === 'string' && typeof i.image === 'string' && i.image) : [];
  const safeSetupVars = Array.isArray(setup_vars) ? setup_vars.filter(sv => sv?.key && sv?.label) : [];

  const id = uuidv4();
  db.prepare('INSERT INTO presets (id, name, description, image, images, port_mappings, env_vars, setup_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, required_rank_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, description, image, JSON.stringify(safeImages), JSON.stringify(port_mappings), JSON.stringify(env_vars), JSON.stringify(safeSetupVars), memory_limit, cpu_limit, Math.max(0, parseInt(disk_limit) || 0), startup_command, install_script, pre_start_script, required_rank_id || null);

  res.status(201).json(parsePreset(db.prepare('SELECT * FROM presets WHERE id = ?').get(id)));
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, description, image, images, port_mappings, env_vars, setup_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, required_rank_id } = req.body;
  const safeImages = images !== undefined
    ? (Array.isArray(images) ? images.filter(i => i && typeof i.label === 'string' && typeof i.image === 'string' && i.image) : [])
    : JSON.parse(existing.images || '[]');
  const safeSetupVars = setup_vars !== undefined
    ? (Array.isArray(setup_vars) ? setup_vars.filter(sv => sv?.key && sv?.label) : [])
    : JSON.parse(existing.setup_vars || '[]');
  db.prepare('UPDATE presets SET name=?, description=?, image=?, images=?, port_mappings=?, env_vars=?, setup_vars=?, memory_limit=?, cpu_limit=?, disk_limit=?, startup_command=?, install_script=?, pre_start_script=?, required_rank_id=? WHERE id=?')
    .run(
      name ?? existing.name,
      description ?? existing.description,
      image ?? existing.image,
      JSON.stringify(safeImages),
      JSON.stringify(port_mappings ?? JSON.parse(existing.port_mappings)),
      JSON.stringify(env_vars ?? JSON.parse(existing.env_vars)),
      JSON.stringify(safeSetupVars),
      memory_limit ?? existing.memory_limit,
      cpu_limit ?? existing.cpu_limit,
      disk_limit !== undefined ? Math.max(0, parseInt(disk_limit) || 0) : (existing.disk_limit || 0),
      startup_command ?? existing.startup_command ?? '',
      install_script !== undefined ? install_script : (existing.install_script ?? ''),
      pre_start_script !== undefined ? pre_start_script : (existing.pre_start_script ?? ''),
      required_rank_id !== undefined ? (required_rank_id || null) : (existing.required_rank_id || null),
      req.params.id
    );
  res.json({ ok: true });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM presets WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
