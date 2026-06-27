'use strict';
const { adminClient, makeClient, ensureMockNode, createServer, waitServerStatus, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('servers.test.js', () => {
  let adm;
  let serverId;
  let userId;
  let userClient;

  it('setup — register user + bring mock node online', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await ensureMockNode(adm.getToken());
    await adm.register('srvuser', 'testpass123');
    const users = await adm.get('/api/users');
    userId = users.body.find(u => u.username === 'srvuser').id;
    userClient = makeClient();
    await userClient.login('srvuser', 'testpass123');
  });

  it('GET /api/servers — empty list for new user', async () => {
    const r = await userClient.get('/api/servers');
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    eq(r.body.length, 0);
  });

  it('POST /api/servers — admin creates real server for user', async () => {
    serverId = await createServer(adm.getToken(), userId, 'test-server-a');
    ok(serverId, 'should have serverId');
  });

  it('GET /api/servers — user sees their server', async () => {
    const r = await userClient.get('/api/servers');
    status(r, 200);
    ok(r.body.some(s => s.id === serverId), 'server in list');
  });

  it('GET /api/servers/:id — user can get own server', async () => {
    const r = await userClient.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.id, serverId);
    eq(r.body.name, 'test-server-a');
    eq(r.body.status, 'stopped');
  });

  it('GET /api/servers/:id — other user → 403', async () => {
    await adm.register('otheruser', 'testpass123');
    const c = makeClient();
    await c.login('otheruser', 'testpass123');
    const r = await c.get(`/api/servers/${serverId}`);
    status(r, 403);
  });

  it('PATCH /api/servers/:id/settings — update server name', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, { name: 'renamed-server' });
    status(r, 200);
    const get = await userClient.get(`/api/servers/${serverId}`);
    eq(get.body.name, 'renamed-server', 'name persisted in DB');
  });

  it('PATCH /api/servers/:id/settings — empty name → 400', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, { name: '' });
    status(r, 400);
  });

  it('GET /api/servers/:id — enable_mods and enable_packages default to 1', async () => {
    const r = await userClient.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.enable_mods, 1, 'enable_mods defaults to 1');
    eq(r.body.enable_packages, 1, 'enable_packages defaults to 1');
  });

  it('PATCH /api/servers/:id/settings — can disable mods and packages pages', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, {
      name: 'test-server-a',
      enable_mods: 0,
      enable_packages: 0,
    });
    status(r, 200);
    const get = await userClient.get(`/api/servers/${serverId}`);
    eq(get.body.enable_mods, 0, 'enable_mods persisted as 0');
    eq(get.body.enable_packages, 0, 'enable_packages persisted as 0');
  });

  it('PATCH /api/servers/:id/settings — can re-enable mods and packages pages', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, {
      name: 'test-server-a',
      enable_mods: 1,
      enable_packages: 1,
    });
    status(r, 200);
    const get = await userClient.get(`/api/servers/${serverId}`);
    eq(get.body.enable_mods, 1, 'enable_mods back to 1');
    eq(get.body.enable_packages, 1, 'enable_packages back to 1');
  });

  it('GET /api/servers/:id/stats — node is online → 200', async () => {
    const r = await userClient.get(`/api/servers/${serverId}/stats`);
    status(r, 200);
    ok(typeof r.body === 'object', 'stats object');
  });

  it('POST /api/servers/:id/action — start → 200', async () => {
    const r = await userClient.post(`/api/servers/${serverId}/action`, { action: 'start' });
    status(r, 200);
    ok(r.body.ok);
  });

  it('after start — server status becomes running', async () => {
    await waitServerStatus(adm.getToken(), serverId, 'running');
  });

  it('POST /api/servers/:id/action — stop → 200', async () => {
    const r = await userClient.post(`/api/servers/${serverId}/action`, { action: 'stop' });
    status(r, 200);
    ok(r.body.ok);
  });

  it('after stop — server status becomes stopped', async () => {
    await waitServerStatus(adm.getToken(), serverId, 'stopped');
  });

  it('POST /api/servers/:id/suspend — suspend server', async () => {
    const r = await adm.post(`/api/servers/${serverId}/suspend`);
    status(r, 200);
  });

  it('PATCH /api/servers/:id/settings — suspended blocks non-admin', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, { name: 'suspended-attempt' });
    status(r, 403);
  });

  it('POST /api/servers/:id/unsuspend — unsuspend server', async () => {
    const r = await adm.post(`/api/servers/${serverId}/unsuspend`);
    status(r, 200);
  });

  it('PATCH /api/servers/:id/settings — works after unsuspend', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, { name: 'test-server-a' });
    status(r, 200);
    const get = await userClient.get(`/api/servers/${serverId}`);
    eq(get.body.name, 'test-server-a', 'name persisted after unsuspend');
  });

  it('DELETE /api/servers/:id — non-owner → 403', async () => {
    const c = makeClient();
    await c.login('otheruser', 'testpass123');
    const r = await c.del(`/api/servers/${serverId}`);
    status(r, 403);
  });

  it('DELETE /api/servers/:id — owner can delete', async () => {
    const r = await userClient.del(`/api/servers/${serverId}`);
    status(r, 200);
  });

  it('GET /api/servers/:id — after delete → 404', async () => {
    const r = await userClient.get(`/api/servers/${serverId}`);
    status(r, 404);
  });
});
