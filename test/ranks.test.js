'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('ranks.test.js', () => {
  let adm;
  let userClient;
  let rankId;

  it('setup — login as admin + register a regular user', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await adm.register('rankuser', 'testpass123');
    userClient = makeClient();
    await userClient.login('rankuser', 'testpass123');
  });

  it('GET /api/ranks — accessible to any authenticated user', async () => {
    const r = await userClient.get('/api/ranks');
    status(r, 200);
    ok(Array.isArray(r.body), 'should be array');
    ok(r.body.length >= 1, 'should have at least one default rank');
  });

  it('GET /api/ranks — unauthenticated → 401', async () => {
    const { request } = require('./helpers');
    const r = await request('GET', '/api/ranks', null, null);
    status(r, 401);
  });

  it('GET /api/ranks — admin also gets the list', async () => {
    const r = await adm.get('/api/ranks');
    status(r, 200);
    ok(r.body.length >= 1);
  });

  it('POST /api/ranks — non-admin → 403', async () => {
    const r = await userClient.post('/api/ranks', { name: 'Sneaky', max_servers: 99, sort_order: 0 });
    status(r, 403);
  });

  it('POST /api/ranks — create rank', async () => {
    const r = await adm.post('/api/ranks', {
      name: 'TestRank',
      color: '#ff0000',
      max_servers: 2,
      memory_limit: 1024,
      disk_limit: 0,
      sort_order: 99,
    });
    status(r, 201);
    hasField(r.body, 'id');
    eq(r.body.name, 'TestRank');
    rankId = r.body.id;
  });

  it('POST /api/ranks — duplicate name → 400', async () => {
    const r = await adm.post('/api/ranks', { name: 'TestRank', max_servers: 1, sort_order: 100 });
    status(r, 400);
  });

  it('PUT /api/ranks/:id — update rank', async () => {
    const r = await adm.put(`/api/ranks/${rankId}`, { name: 'TestRank', max_servers: 5, sort_order: 99 });
    status(r, 200);
    eq(r.body.max_servers, 5);
  });

  it('PUT /api/ranks/:id — non-admin → 403', async () => {
    const r = await userClient.put(`/api/ranks/${rankId}`, { name: 'X', max_servers: 1, sort_order: 0 });
    status(r, 403);
  });

  it('PUT /api/ranks/:id — non-existent → 404', async () => {
    const r = await adm.put('/api/ranks/nonexistent-id', { name: 'X' });
    status(r, 404);
  });

  it('DELETE /api/ranks/:id — delete rank', async () => {
    const r = await adm.del(`/api/ranks/${rankId}`);
    status(r, 200);
  });

  it('DELETE /api/ranks/:id — already deleted → 404', async () => {
    const r = await adm.del(`/api/ranks/${rankId}`);
    status(r, 404);
  });
});
