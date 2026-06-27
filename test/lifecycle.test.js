'use strict';
// Full server lifecycle test using the real API + mock daemon.
// Tests: preset deploy, admin create, start, stop, restart, delete.
const { adminClient, makeClient, ensureMockNode, createServer, waitServerStatus, reset, request } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('lifecycle.test.js', () => {
  let adm;
  let userId;
  let userClient;
  let nodeId;
  let presetId;
  let presetsServerId;
  let adminServerId;

  it('setup — register user and connect mock daemon', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    nodeId = await ensureMockNode(adm.getToken());
    ok(nodeId, 'mock node should be online');

    await adm.register('lcuser', 'testpass123');
    const users = await adm.get('/api/users');
    userId = users.body.find(u => u.username === 'lcuser').id;

    userClient = makeClient();
    await userClient.login('lcuser', 'testpass123');
  });

  // ── Preset deploy flow ────────────────────────────────────────────────────────

  it('create a test preset', async () => {
    const r = await adm.post('/api/presets', {
      name: 'test-lifecycle-preset',
      image: 'alpine:latest',
      memory_limit: 256,
      cpu_limit: 0.5,
      startup_command: 'sh',
    });
    status(r, 201);
    hasField(r.body, 'id');
    presetId = r.body.id;
  });

  it('POST /api/servers/from-preset — user deploys preset → 202', async () => {
    const r = await userClient.post('/api/servers/from-preset', {
      name: 'test-preset-server',
      preset_id: presetId,
    });
    status(r, 202);
    hasField(r.body, 'id');
    eq(r.body.status, 'installing');
    presetsServerId = r.body.id;
  });

  it('after install — preset server reaches stopped', async () => {
    await waitServerStatus(adm.getToken(), presetsServerId, 'stopped');
    const r = await userClient.get(`/api/servers/${presetsServerId}`);
    status(r, 200);
    eq(r.body.status, 'stopped');
    ok(r.body.container_id, 'should have a container_id after install');
  });

  it('start preset server', async () => {
    const r = await userClient.post(`/api/servers/${presetsServerId}/action`, { action: 'start' });
    status(r, 200);
    ok(r.body.ok);
    await waitServerStatus(adm.getToken(), presetsServerId, 'running');
  });

  it('preset server is running', async () => {
    const r = await userClient.get(`/api/servers/${presetsServerId}`);
    status(r, 200);
    eq(r.body.status, 'running');
  });

  it('GET /api/servers/:id/stats — returns stats while running', async () => {
    const r = await userClient.get(`/api/servers/${presetsServerId}/stats`);
    status(r, 200);
    ok(typeof r.body.cpu !== 'undefined', 'should have cpu stat');
  });

  it('stop preset server', async () => {
    const r = await userClient.post(`/api/servers/${presetsServerId}/action`, { action: 'stop' });
    status(r, 200);
    await waitServerStatus(adm.getToken(), presetsServerId, 'stopped');
  });

  it('restart preset server (start → running → stop → running in one action)', async () => {
    // First start so we have something to restart from
    await userClient.post(`/api/servers/${presetsServerId}/action`, { action: 'start' });
    await waitServerStatus(adm.getToken(), presetsServerId, 'running');

    const r = await userClient.post(`/api/servers/${presetsServerId}/action`, { action: 'restart' });
    status(r, 200);
    // After restart the mock daemon sends 'running' (same as start)
    await waitServerStatus(adm.getToken(), presetsServerId, 'running');
  });

  it('DELETE preset server (from running state) → 200', async () => {
    // Stop first (delete while running is allowed but let's test clean shutdown)
    await userClient.post(`/api/servers/${presetsServerId}/action`, { action: 'stop' });
    await waitServerStatus(adm.getToken(), presetsServerId, 'stopped');

    const r = await userClient.del(`/api/servers/${presetsServerId}`);
    status(r, 200);
    ok(r.body.ok);
  });

  it('after preset server delete → 404', async () => {
    const r = await userClient.get(`/api/servers/${presetsServerId}`);
    status(r, 404);
  });

  // ── Admin direct create flow ─────────────────────────────────────────────────

  it('POST /api/servers (admin) — create server directly for user', async () => {
    adminServerId = await createServer(adm.getToken(), userId, 'test-admin-direct', {
      image: 'alpine:latest',
      startup_command: 'sh',
    });
    ok(adminServerId, 'should have serverId');
  });

  it('admin-created server is in stopped state', async () => {
    const r = await adm.get(`/api/servers/${adminServerId}`);
    status(r, 200);
    eq(r.body.status, 'stopped');
    eq(r.body.owner_id, userId);
    ok(r.body.container_id, 'should have container_id');
  });

  it('start admin-created server', async () => {
    const r = await userClient.post(`/api/servers/${adminServerId}/action`, { action: 'start' });
    status(r, 200);
    await waitServerStatus(adm.getToken(), adminServerId, 'running');
  });

  it('kill admin-created server', async () => {
    const r = await userClient.post(`/api/servers/${adminServerId}/action`, { action: 'kill' });
    status(r, 200);
    await waitServerStatus(adm.getToken(), adminServerId, 'stopped');
  });

  it('DELETE admin-created server', async () => {
    const r = await adm.del(`/api/servers/${adminServerId}`);
    status(r, 200);
  });

  // ── Node visibility ───────────────────────────────────────────────────────────

  it('GET /api/nodes — node shows as online', async () => {
    const r = await adm.get('/api/nodes');
    status(r, 200);
    const node = r.body.find(n => n.id === nodeId);
    ok(node, 'mock node should be in list');
    ok(node.online, 'mock node should be online');
  });

  it('GET /api/nodes/:id — shows node detail', async () => {
    const r = await adm.get(`/api/nodes/${nodeId}`);
    status(r, 200);
    eq(r.body.id, nodeId);
    ok(r.body.online, 'online');
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  it('cleanup preset', async () => {
    const r = await adm.del(`/api/presets/${presetId}`);
    status(r, 200);
  });
});
