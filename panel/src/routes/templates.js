const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');


const router = express.Router();
router.use(requireAuth);

function parseTemplate(t) {
  return {
    ...t,
    env_vars: JSON.parse(t.env_vars || '[]'),
    files: JSON.parse(t.files || '[]'),
  };
}

function rankCheck(user) {
  if (user.role === 'admin') return null;
  const u = db.prepare('SELECT rank_id FROM users WHERE id = ?').get(user.id);
  if (!u?.rank_id) return { sort_order: -1 };
  const r = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(u.rank_id);
  return r || { sort_order: -1 };
}

router.get('/', (req, res) => {
  const all = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
  if (req.user.role === 'admin') return res.json(all.map(parseTemplate));

  const userRank = rankCheck(req.user);
  const visible = all.filter(t => {
    if (!t.required_rank_id) return true;
    const req_rank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(t.required_rank_id);
    return !req_rank || (userRank?.sort_order ?? -1) >= req_rank.sort_order;
  });
  res.json(visible.map(parseTemplate));
});

function templateToExportShape(t) {
  return {
    name: t.name,
    description: t.description || '',
    image: t.image,
    env_vars: JSON.parse(t.env_vars || '[]'),
    files: JSON.parse(t.files || '[]'),
    memory_limit: t.memory_limit,
    cpu_limit: t.cpu_limit,
    disk_limit: t.disk_limit || 0,
    startup_command: t.startup_command || '',
    install_script: t.install_script || '',
    pre_start_script: t.pre_start_script || '',
  };
}

// Export a single template by ID
router.get('/:id/export', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const safeName = t.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  res.setHeader('Content-Disposition', `attachment; filename="template-${safeName}.json"`);
  res.json({ version: 1, exported_at: new Date().toISOString(), templates: [templateToExportShape(t)] });
});

router.post('/import', requireAdmin, (req, res) => {
  const list = req.body?.templates;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: 'Body must have a non-empty templates array' });
  let imported = 0;
  const errors = [];
  for (const t of list) {
    if (!t.name || !t.image) { errors.push(`Skipped entry: missing name or image`); continue; }
    const id = uuidv4();
    try {
      db.prepare(`INSERT INTO templates (id, name, description, image, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, required_rank_id, files) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`)
        .run(id, String(t.name).trim(), String(t.description || ''), String(t.image).trim(),
          JSON.stringify(Array.isArray(t.env_vars) ? t.env_vars : []),
          t.memory_limit || 512, t.cpu_limit || 1.0,
          Math.max(0, parseInt(t.disk_limit) || 0),
          t.startup_command || '', t.install_script || '', t.pre_start_script || '',
          JSON.stringify(Array.isArray(t.files) ? t.files : []));
      imported++;
    } catch (err) {
      errors.push(`Failed "${t.name}": ${err.message}`);
    }
  }
  res.json({ ok: true, imported, errors });
});

router.get('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });

  if (req.user.role !== 'admin' && t.required_rank_id) {
    const userRank = rankCheck(req.user);
    const req_rank = db.prepare('SELECT sort_order FROM ranks WHERE id = ?').get(t.required_rank_id);
    if (req_rank && (userRank?.sort_order ?? -1) < req_rank.sort_order) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  res.json(parseTemplate(t));
});

router.post('/', requireAdmin, (req, res) => {
  const { name, description = '', image, env_vars = [], memory_limit = 512, cpu_limit = 1.0,
    disk_limit = 0, startup_command = '', install_script = '', pre_start_script = '', required_rank_id, files = [] } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image are required' });

  const id = uuidv4();
  db.prepare(`INSERT INTO templates (id, name, description, image, env_vars, memory_limit, cpu_limit, disk_limit, startup_command, install_script, pre_start_script, required_rank_id, files)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, description, image,
      JSON.stringify(env_vars), memory_limit, cpu_limit, disk_limit,
      startup_command, install_script, pre_start_script, required_rank_id || null,
      JSON.stringify(files));

  res.status(201).json(parseTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id)));
});

router.patch('/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });

  const fields = ['name','description','image','memory_limit','cpu_limit','disk_limit','startup_command','install_script','pre_start_script','required_rank_id'];
  const updates = [], values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (req.body.env_vars !== undefined) { updates.push('env_vars = ?'); values.push(JSON.stringify(req.body.env_vars)); }
  if (req.body.files !== undefined)    { updates.push('files = ?');    values.push(JSON.stringify(req.body.files));    }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE templates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(parseTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
