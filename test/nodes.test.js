'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('nodes.test.js', () => {
  let adm;
  let nodeId;
  let origToken;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
  });

  it('GET /api/nodes — returns list (any auth)', async () => {
    const r = await adm.get('/api/nodes');
    status(r, 200);
    ok(Array.isArray(r.body), 'should be array');
  });

  it('POST /api/nodes — non-admin → 403', async () => {
    await adm.register('nodeuser', 'testpass123');
    const c = makeClient();
    await c.login('nodeuser', 'testpass123');
    const r = await c.post('/api/nodes', { name: 'Sneaky Node' });
    status(r, 403);
  });

  it('POST /api/nodes — create node', async () => {
    const r = await adm.post('/api/nodes', {
      name: 'Test Node Alpha',
      description: 'unit test node',
      memory: 8192,
      cpu: 4,
      disk_limit: 0,
      port_range_start: 20000,
      port_range_end: 20100,
    });
    status(r, 201);
    hasField(r.body, 'id');
    hasField(r.body, 'token');
    nodeId = r.body.id;
    origToken = r.body.token;
  });

  it('POST /api/nodes — missing name → 400', async () => {
    const r = await adm.post('/api/nodes', { memory: 1024 });
    status(r, 400);
  });

  it('GET /api/nodes/:id — get node', async () => {
    const r = await adm.get(`/api/nodes/${nodeId}`);
    status(r, 200);
    eq(r.body.name, 'Test Node Alpha');
  });

  it('PATCH /api/nodes/:id — update node', async () => {
    const r = await adm.patch(`/api/nodes/${nodeId}`, { name: 'Test Node Alpha Updated', memory: 16384 });
    status(r, 200);
    const get = await adm.get(`/api/nodes/${nodeId}`);
    eq(get.body.name, 'Test Node Alpha Updated', 'name persisted');
    eq(get.body.memory, 16384, 'memory persisted');
  });

  it('POST /api/nodes/:id/reset-token — resets daemon token', async () => {
    const r = await adm.post(`/api/nodes/${nodeId}/reset-token`);
    status(r, 200);
    hasField(r.body, 'token');
    ok(r.body.token !== origToken, 'token should change');
  });

  it('DELETE /api/nodes/:id — delete node', async () => {
    const r = await adm.del(`/api/nodes/${nodeId}`);
    status(r, 200);
  });

  it('GET /api/nodes/:id — after delete → 404', async () => {
    const r = await adm.get(`/api/nodes/${nodeId}`);
    status(r, 404);
  });
});
