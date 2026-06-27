'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('users.test.js', () => {
  let adm;
  let userId;
  let rankId;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await adm.register('targetuser', 'testpass123');

    const users = await adm.get('/api/users');
    const u = users.body.find(x => x.username === 'targetuser');
    userId = u.id;

    const r = await adm.post('/api/ranks', { name: 'UserTestRank', color: '#aaa', max_servers: 3, sort_order: 88 });
    rankId = r.body.id;
  });

  it('GET /api/users — non-admin → 403', async () => {
    const c = makeClient();
    await c.login('targetuser', 'testpass123');
    const r = await c.get('/api/users');
    status(r, 403);
  });

  it('GET /api/users — admin → list', async () => {
    const r = await adm.get('/api/users');
    status(r, 200);
    ok(Array.isArray(r.body), 'should be array');
    ok(r.body.some(u => u.username === 'admin'), 'admin should be in list');
  });

  it('POST /api/users/:id/suspend — suspend user', async () => {
    const r = await adm.post(`/api/users/${userId}/suspend`);
    status(r, 200);
  });

  it('suspended user login → 403', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/login', { username: 'targetuser', password: 'testpass123' });
    status(r, 403);
  });

  it('POST /api/users/:id/unsuspend — unsuspend user', async () => {
    const r = await adm.post(`/api/users/${userId}/unsuspend`);
    status(r, 200);
  });

  it('unsuspended user can login again', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/login', { username: 'targetuser', password: 'testpass123' });
    status(r, 200);
  });

  it('PATCH /api/users/:id/role — set role to admin', async () => {
    const r = await adm.patch(`/api/users/${userId}/role`, { role: 'admin' });
    status(r, 200);
    const users = await adm.get('/api/users');
    eq(users.body.find(u => u.id === userId).role, 'admin', 'role persisted in DB');
  });

  it('PATCH /api/users/:id/role — set back to user', async () => {
    const r = await adm.patch(`/api/users/${userId}/role`, { role: 'user' });
    status(r, 200);
    const users = await adm.get('/api/users');
    eq(users.body.find(u => u.id === userId).role, 'user', 'role reverted');
  });

  it('PATCH /api/users/:id/role — invalid role → 400', async () => {
    const r = await adm.patch(`/api/users/${userId}/role`, { role: 'superadmin' });
    status(r, 400);
  });

  it('PATCH /api/users/:id/rank — assign rank', async () => {
    const r = await adm.patch(`/api/users/${userId}/rank`, { rank_id: rankId });
    status(r, 200);
    const users = await adm.get('/api/users');
    eq(users.body.find(u => u.id === userId).rank_id, rankId, 'rank_id persisted');
  });

  it('PATCH /api/users/:id/rank — remove rank', async () => {
    const r = await adm.patch(`/api/users/${userId}/rank`, { rank_id: null });
    status(r, 200);
    const users = await adm.get('/api/users');
    ok(users.body.find(u => u.id === userId).rank_id == null, 'rank_id cleared');
  });

  it('DELETE /api/users/:id — delete user', async () => {
    const r = await adm.del(`/api/users/${userId}`);
    status(r, 200);
  });

  it('DELETE /api/users/:id — nonexistent → 404', async () => {
    const r = await adm.del(`/api/users/${userId}`);
    status(r, 404);
  });

  it('DELETE /api/ranks/:id — clean up rank', async () => {
    const r = await adm.del(`/api/ranks/${rankId}`);
    status(r, 200);
  });
});
