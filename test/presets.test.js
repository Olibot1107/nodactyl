'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('presets.test.js', () => {
  let adm;
  let presetId;
  let rankId;
  let userClient;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await adm.register('presetuser', 'testpass123');
    userClient = makeClient();
    await userClient.login('presetuser', 'testpass123');
  });

  it('POST /api/presets — non-admin → 403', async () => {
    const r = await userClient.post('/api/presets', { name: 'Evil Preset', image: 'nginx', memory_limit: 512, cpu_limit: 1 });
    status(r, 403);
  });

  it('POST /api/presets — create preset', async () => {
    const r = await adm.post('/api/presets', {
      name: 'Test Nginx',
      image: 'nginx:latest',
      memory_limit: 256,
      cpu_limit: 0.5,
      disk_limit: 0,
      env_vars: [{ key: 'PORT', value: '80' }],
      startup_command: 'nginx -g "daemon off;"',
    });
    status(r, 201);
    hasField(r.body, 'id');
    eq(r.body.name, 'Test Nginx');
    presetId = r.body.id;
  });

  it('GET /api/presets — user sees unrestricted preset', async () => {
    const r = await userClient.get('/api/presets');
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    ok(r.body.some(p => p.id === presetId), 'preset visible');
  });

  it('GET /api/presets/:id — user can get unrestricted preset', async () => {
    const r = await userClient.get(`/api/presets/${presetId}`);
    status(r, 200);
    eq(r.body.id, presetId);
  });

  it('POST /api/presets — with rank gate hides from lower-rank users', async () => {
    const rr = await adm.post('/api/ranks', { name: 'GatedRank', max_servers: 1, sort_order: 77 });
    rankId = rr.body.id;
    const r = await adm.post('/api/presets', {
      name: 'Gated Preset',
      image: 'alpine:latest',
      memory_limit: 512,
      cpu_limit: 1,
      required_rank_id: rankId,
    });
    status(r, 201);
    const gatedId = r.body.id;

    // Get user id
    const users = await adm.get('/api/users');
    const presetUserId = users.body.find(u => u.username === 'presetuser').id;

    // User without rank should not see gated preset
    const list = await userClient.get('/api/presets');
    status(list, 200);
    ok(!list.body.some(p => p.id === gatedId), 'gated preset hidden from low-rank user');

    // GET single also hidden
    const single = await userClient.get(`/api/presets/${gatedId}`);
    status(single, 403);

    // Assign the rank → user should now see the preset
    await adm.patch(`/api/users/${presetUserId}/rank`, { rank_id: rankId });
    const listAfter = await userClient.get('/api/presets');
    ok(listAfter.body.some(p => p.id === gatedId), 'user with rank can now see gated preset');
    const singleAfter = await userClient.get(`/api/presets/${gatedId}`);
    status(singleAfter, 200);

    // Remove rank again
    await adm.patch(`/api/users/${presetUserId}/rank`, { rank_id: null });

    // Clean up
    await adm.del(`/api/presets/${gatedId}`);
    await adm.del(`/api/ranks/${rankId}`);
  });

  it('PUT /api/presets/:id — update preset', async () => {
    const r = await adm.put(`/api/presets/${presetId}`, {
      name: 'Test Nginx Updated',
      image: 'nginx:latest',
      memory_limit: 512,
      cpu_limit: 1,
    });
    status(r, 200);
    ok(r.body.ok, 'should return ok');
    // Verify by re-fetching
    const get = await adm.get(`/api/presets/${presetId}`);
    status(get, 200);
    eq(get.body.memory_limit, 512);
  });

  it('PUT /api/presets/:id — non-admin → 403', async () => {
    const r = await userClient.put(`/api/presets/${presetId}`, {
      name: 'Hacked',
      image: 'evil:latest',
      memory_limit: 999,
      cpu_limit: 1,
    });
    status(r, 403);
  });

  it('DELETE /api/presets/:id — non-admin → 403', async () => {
    const r = await userClient.del(`/api/presets/${presetId}`);
    status(r, 403);
  });

  it('DELETE /api/presets/:id — admin can delete', async () => {
    const r = await adm.del(`/api/presets/${presetId}`);
    status(r, 200);
  });

  it('GET /api/presets/:id — after delete → 404', async () => {
    const r = await adm.get(`/api/presets/${presetId}`);
    status(r, 404);
  });
});
