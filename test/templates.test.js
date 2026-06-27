'use strict';
const { adminClient, makeClient, ensureMockNode, waitServerStatus, reset, request } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('templates.test.js', () => {
  let adm;
  let userClient;
  let userId;
  let templateId;
  let rankId;
  let nodeId;

  it('setup — register user + connect mock node', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    nodeId = await ensureMockNode(adm.getToken());
    await adm.register('tmpluser', 'testpass123');
    const users = await adm.get('/api/users');
    userId = users.body.find(u => u.username === 'tmpluser').id;
    userClient = makeClient();
    await userClient.login('tmpluser', 'testpass123');
  });

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  it('GET /api/templates — empty list initially', async () => {
    const r = await userClient.get('/api/templates');
    status(r, 200);
    ok(Array.isArray(r.body));
  });

  it('POST /api/templates — non-admin → 403', async () => {
    const r = await userClient.post('/api/templates', { name: 'Bad', image: 'alpine' });
    status(r, 403);
  });

  it('POST /api/templates — missing name → 400', async () => {
    const r = await adm.post('/api/templates', { image: 'alpine:latest' });
    status(r, 400);
  });

  it('POST /api/templates — create template', async () => {
    const r = await adm.post('/api/templates', {
      name: 'Test Alpine',
      description: 'Simple alpine template',
      image: 'alpine:latest',
      memory_limit: 256,
      cpu_limit: 0.5,
      startup_command: 'sh',
      env_vars: [{ key: 'FOO', value: 'bar' }],
      files: [{ path: 'hello.txt', content: 'Hello world' }],
    });
    status(r, 201);
    hasField(r.body, 'id');
    eq(r.body.name, 'Test Alpine');
    ok(Array.isArray(r.body.env_vars));
    ok(Array.isArray(r.body.files) && r.body.files.length === 1);
    templateId = r.body.id;
  });

  it('GET /api/templates — user sees template', async () => {
    const r = await userClient.get('/api/templates');
    status(r, 200);
    ok(r.body.some(t => t.id === templateId));
  });

  it('GET /api/templates/:id — user can get template', async () => {
    const r = await userClient.get(`/api/templates/${templateId}`);
    status(r, 200);
    eq(r.body.id, templateId);
    eq(r.body.image, 'alpine:latest');
  });

  it('PATCH /api/templates/:id — non-admin → 403', async () => {
    const r = await userClient.patch(`/api/templates/${templateId}`, { name: 'Hacked' });
    status(r, 403);
  });

  it('PATCH /api/templates/:id — update fields', async () => {
    const r = await adm.patch(`/api/templates/${templateId}`, { memory_limit: 512, description: 'Updated' });
    status(r, 200);
    eq(r.body.memory_limit, 512);
    eq(r.body.description, 'Updated');
  });

  it('PATCH /api/templates/:id — nothing to update → 400', async () => {
    const r = await adm.patch(`/api/templates/${templateId}`, {});
    status(r, 400);
  });

  it('PATCH /api/templates/:id — nonexistent → 404', async () => {
    const r = await adm.patch('/api/templates/bad-id', { name: 'X' });
    status(r, 404);
  });

  // ── Rank gating ───────────────────────────────────────────────────────────────

  it('rank-gated template hidden from low-rank users', async () => {
    const rr = await adm.post('/api/ranks', { name: 'TmplRank', max_servers: 1, sort_order: 88 });
    rankId = rr.body.id;
    const t = await adm.post('/api/templates', {
      name: 'Gated Template',
      image: 'alpine:latest',
      memory_limit: 128,
      cpu_limit: 0.25,
      required_rank_id: rankId,
    });
    const gatedId = t.body.id;

    const list = await userClient.get('/api/templates');
    ok(!list.body.some(x => x.id === gatedId), 'gated template hidden from low-rank user');

    const single = await userClient.get(`/api/templates/${gatedId}`);
    status(single, 403);

    // Admin always sees all
    const adminList = await adm.get('/api/templates');
    ok(adminList.body.some(x => x.id === gatedId), 'admin sees gated template');

    // Cleanup
    await adm.del(`/api/templates/${gatedId}`);
    await adm.del(`/api/ranks/${rankId}`);
  });

  // ── Server creation from template ─────────────────────────────────────────────

  it('POST /api/servers/from-template — deploys template → 202', async () => {
    const r = await userClient.post('/api/servers/from-template', {
      name: 'test-tmpl-server',
      template_id: templateId,
    });
    status(r, 202);
    hasField(r.body, 'id');
    eq(r.body.status, 'installing');

    // Wait for install
    await waitServerStatus(adm.getToken(), r.body.id, 'stopped');

    // Verify
    const srv = await userClient.get(`/api/servers/${r.body.id}`);
    status(srv, 200);
    eq(srv.body.status, 'stopped');
    ok(srv.body.container_id, 'has container id after install');

    // Cleanup
    await userClient.del(`/api/servers/${r.body.id}`);
  });

  it('POST /api/servers/from-template — unknown template → 404', async () => {
    const r = await userClient.post('/api/servers/from-template', {
      name: 'Nope',
      template_id: 'nonexistent',
    });
    status(r, 404);
  });

  it('POST /api/servers/from-template — missing name → 400', async () => {
    const r = await userClient.post('/api/servers/from-template', { template_id: templateId });
    status(r, 400);
  });

  // ── Delete ────────────────────────────────────────────────────────────────────

  it('DELETE /api/templates/:id — non-admin → 403', async () => {
    const r = await userClient.del(`/api/templates/${templateId}`);
    status(r, 403);
  });

  it('DELETE /api/templates/:id — admin can delete', async () => {
    const r = await adm.del(`/api/templates/${templateId}`);
    status(r, 200);
  });

  it('DELETE /api/templates/:id — already deleted → 404', async () => {
    const r = await adm.del(`/api/templates/${templateId}`);
    status(r, 404);
  });
});
