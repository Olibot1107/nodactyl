'use strict';
// Tests for preset + template import / export.
// Includes a round-trip with the real PaperMC preset shape.
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

// PaperMC preset — mirrors the real file structure
const PAPERMC_PRESET = {
  name: 'Paper MC',
  description: 'High-performance Minecraft server powered by PaperMC.',
  image: 'eclipse-temurin:21-jre-alpine',
  images: [
    { label: 'Java 21 — 1.20.6 to 1.21.x (Recommended)', image: 'eclipse-temurin:21-jre-alpine' },
    { label: 'Java 17 — 1.18 to 1.20.4',                  image: 'eclipse-temurin:17-jre-alpine' },
    { label: 'Java 11 — 1.16.x',                           image: 'eclipse-temurin:11-jre-alpine' },
  ],
  env_vars: [{ key: 'MC_VERSION', value: 'LATEST' }],
  setup_vars: [{ key: 'MC_VERSION', label: 'Minecraft Version', description: 'e.g. 1.21.4 or LATEST' }],
  memory_limit: 2048,
  cpu_limit: 2,
  disk_limit: 10240,
  startup_command: 'java -Xmx1536M -Xms512M -jar server.jar --nogui',
  install_script: 'echo "install"',
  pre_start_script: '',
};

describe('import-export.test.js', () => {
  let adm;
  let presetId;
  let templateId;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
  });

  // ── Preset import ─────────────────────────────────────────────────────────────

  it('POST /api/presets/import — non-admin → 403', async () => {
    await adm.register('impuser', 'testpass123');
    const c = makeClient();
    await c.login('impuser', 'testpass123');
    const r = await c.post('/api/presets/import', { presets: [{ name: 'X', image: 'alpine' }] });
    status(r, 403);
  });

  it('POST /api/presets/import — empty array → 400', async () => {
    const r = await adm.post('/api/presets/import', { presets: [] });
    status(r, 400);
  });

  it('POST /api/presets/import — missing presets key → 400', async () => {
    const r = await adm.post('/api/presets/import', {});
    status(r, 400);
  });

  it('POST /api/presets/import — entry missing name → counted in errors', async () => {
    const r = await adm.post('/api/presets/import', { presets: [{ image: 'alpine' }] });
    status(r, 200);
    ok(r.body.ok);
    eq(r.body.imported, 0);
    ok(r.body.errors.length > 0, 'should have an error entry');
  });

  it('POST /api/presets/import — valid preset imported', async () => {
    const r = await adm.post('/api/presets/import', {
      presets: [{
        name: 'Imported Nginx',
        image: 'nginx:alpine',
        memory_limit: 256,
        cpu_limit: 0.5,
      }],
    });
    status(r, 200);
    ok(r.body.ok);
    eq(r.body.imported, 1);
    eq(r.body.errors.length, 0);
  });

  it('POST /api/presets/import — PaperMC full preset round-trip', async () => {
    const r = await adm.post('/api/presets/import', { presets: [PAPERMC_PRESET] });
    status(r, 200);
    ok(r.body.ok);
    eq(r.body.imported, 1);
    eq(r.body.errors.length, 0);
  });

  it('imported PaperMC preset has correct fields', async () => {
    const list = await adm.get('/api/presets');
    status(list, 200);
    const paper = list.body.find(p => p.name === 'Paper MC');
    ok(paper, 'PaperMC preset should be in list');
    eq(paper.image, 'eclipse-temurin:21-jre-alpine');
    eq(paper.memory_limit, 2048);
    eq(paper.cpu_limit, 2);
    eq(paper.disk_limit, 10240);
    ok(Array.isArray(paper.images) && paper.images.length === 3, 'should have 3 image options');
    ok(Array.isArray(paper.setup_vars) && paper.setup_vars.length === 1, 'should have 1 setup var');
    eq(paper.setup_vars[0].key, 'MC_VERSION');
    ok(paper.env_vars.some(e => e.key === 'MC_VERSION'), 'should have MC_VERSION env var');
    presetId = paper.id;
  });

  it('POST /api/presets/import — multiple presets in one call', async () => {
    const r = await adm.post('/api/presets/import', {
      presets: [
        { name: 'Batch A', image: 'alpine:latest', memory_limit: 128, cpu_limit: 0.25 },
        { name: 'Batch B', image: 'alpine:latest', memory_limit: 256, cpu_limit: 0.5 },
        { image: 'alpine:latest' },  // missing name — should error but not abort others
      ],
    });
    status(r, 200);
    eq(r.body.imported, 2);
    eq(r.body.errors.length, 1);
  });

  // ── Preset export ─────────────────────────────────────────────────────────────

  it('GET /api/presets/:id/export — non-admin → 403', async () => {
    const c = makeClient();
    await c.login('impuser', 'testpass123');
    const r = await c.get(`/api/presets/${presetId}/export`);
    status(r, 403);
  });

  it('GET /api/presets/:id/export — unknown id → 404', async () => {
    const r = await adm.get('/api/presets/nonexistent-id/export');
    status(r, 404);
  });

  it('GET /api/presets/:id/export — returns exportable JSON', async () => {
    const r = await adm.get(`/api/presets/${presetId}/export`);
    status(r, 200);
    eq(r.body.version, 1);
    hasField(r.body, 'exported_at');
    ok(Array.isArray(r.body.presets) && r.body.presets.length === 1, 'should have 1 preset');
    const p = r.body.presets[0];
    eq(p.name, 'Paper MC');
    eq(p.image, 'eclipse-temurin:21-jre-alpine');
    eq(p.memory_limit, 2048);
    ok(Array.isArray(p.images), 'images array present');
    ok(Array.isArray(p.setup_vars), 'setup_vars array present');
    ok(!p.id, 'export should not include DB id');
  });

  it('export → import round-trip preserves all fields', async () => {
    // Export the PaperMC preset
    const exported = await adm.get(`/api/presets/${presetId}/export`);
    const exportedPreset = { ...exported.body.presets[0], name: 'Paper MC Reimported' };

    // Delete the original
    await adm.del(`/api/presets/${presetId}`);

    // Import from exported data
    const imported = await adm.post('/api/presets/import', { presets: [exportedPreset] });
    status(imported, 200);
    eq(imported.body.imported, 1);

    // Verify the re-imported preset
    const list = await adm.get('/api/presets');
    const reimported = list.body.find(p => p.name === 'Paper MC Reimported');
    ok(reimported, 'reimported preset should be in list');
    eq(reimported.memory_limit, 2048);
    eq(reimported.disk_limit, 10240);
    ok(reimported.images.length === 3, 'images preserved');
    ok(reimported.setup_vars.length === 1, 'setup_vars preserved');
    presetId = reimported.id;
  });

  // ── Template import ───────────────────────────────────────────────────────────

  it('POST /api/templates/import — non-admin → 403', async () => {
    const c = makeClient();
    await c.login('impuser', 'testpass123');
    const r = await c.post('/api/templates/import', { templates: [{ name: 'X', image: 'alpine' }] });
    status(r, 403);
  });

  it('POST /api/templates/import — empty array → 400', async () => {
    const r = await adm.post('/api/templates/import', { templates: [] });
    status(r, 400);
  });

  it('POST /api/templates/import — valid template', async () => {
    const r = await adm.post('/api/templates/import', {
      templates: [{
        name: 'Imported Template',
        image: 'alpine:latest',
        memory_limit: 128,
        cpu_limit: 0.25,
        startup_command: 'sh',
        files: [{ path: 'start.sh', content: '#!/bin/sh\necho hello' }],
      }],
    });
    status(r, 200);
    ok(r.body.ok);
    eq(r.body.imported, 1);
  });

  it('imported template has correct fields', async () => {
    const list = await adm.get('/api/templates');
    status(list, 200);
    const t = list.body.find(x => x.name === 'Imported Template');
    ok(t, 'template in list');
    eq(t.image, 'alpine:latest');
    ok(Array.isArray(t.files) && t.files.length === 1, 'files preserved');
    templateId = t.id;
  });

  // ── Template export ───────────────────────────────────────────────────────────

  it('GET /api/templates/:id/export — returns exportable JSON', async () => {
    const r = await adm.get(`/api/templates/${templateId}/export`);
    status(r, 200);
    eq(r.body.version, 1);
    ok(Array.isArray(r.body.templates) && r.body.templates.length === 1);
    const t = r.body.templates[0];
    eq(t.name, 'Imported Template');
    ok(!t.id, 'no DB id in export');
    ok(Array.isArray(t.files), 'files array present');
  });

  it('GET /api/templates/:id/export — unknown → 404', async () => {
    const r = await adm.get('/api/templates/bad-id/export');
    status(r, 404);
  });

  it('GET /api/templates/:id/export — non-admin → 403', async () => {
    const c = makeClient();
    await c.login('impuser', 'testpass123');
    const r = await c.get(`/api/templates/${templateId}/export`);
    status(r, 403);
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  it('cleanup', async () => {
    if (presetId) await adm.del(`/api/presets/${presetId}`);
    if (templateId) await adm.del(`/api/templates/${templateId}`);
  });
});
