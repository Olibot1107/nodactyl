const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function parsePreset(p) {
  return { ...p, port_mappings: JSON.parse(p.port_mappings), env_vars: JSON.parse(p.env_vars) };
}

router.get('/', (req, res) => {
  const presets = db.prepare('SELECT * FROM presets ORDER BY name ASC').all();
  res.json(presets.map(parsePreset));
});

router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(parsePreset(p));
});

router.post('/', requireAdmin, (req, res) => {
  const { name, description = '', image, port_mappings = [], env_vars = [], memory_limit = 512, cpu_limit = 1.0, startup_command = '' } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image are required' });

  const id = uuidv4();
  db.prepare('INSERT INTO presets (id, name, description, image, port_mappings, env_vars, memory_limit, cpu_limit, startup_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, description, image, JSON.stringify(port_mappings), JSON.stringify(env_vars), memory_limit, cpu_limit, startup_command);

  res.status(201).json(parsePreset(db.prepare('SELECT * FROM presets WHERE id = ?').get(id)));
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM presets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, description, image, port_mappings, env_vars, memory_limit, cpu_limit, startup_command } = req.body;
  db.prepare('UPDATE presets SET name=?, description=?, image=?, port_mappings=?, env_vars=?, memory_limit=?, cpu_limit=?, startup_command=? WHERE id=?')
    .run(
      name ?? existing.name,
      description ?? existing.description,
      image ?? existing.image,
      JSON.stringify(port_mappings ?? JSON.parse(existing.port_mappings)),
      JSON.stringify(env_vars ?? JSON.parse(existing.env_vars)),
      memory_limit ?? existing.memory_limit,
      cpu_limit ?? existing.cpu_limit,
      startup_command ?? existing.startup_command ?? '',
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
