'use strict';
const { adminClient, makeClient, seedServer, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('members.test.js', () => {
  let adm;
  let ownerId, memberId;
  let serverId;
  let ownerClient, memberClient;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await adm.register('memOwner', 'testpass123');
    await adm.register('memMember', 'testpass123');

    const users = await adm.get('/api/users');
    ownerId = users.body.find(u => u.username === 'memOwner').id;
    memberId = users.body.find(u => u.username === 'memMember').id;

    ownerClient = makeClient();
    await ownerClient.login('memOwner', 'testpass123');
    memberClient = makeClient();
    await memberClient.login('memMember', 'testpass123');

    const seed = await seedServer(adm.getToken(), ownerId, 'test-member-server');
    serverId = seed.serverId;
  });

  it('GET /api/servers/:id/members — owner can list (empty)', async () => {
    const r = await ownerClient.get(`/api/servers/${serverId}/members`);
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    eq(r.body.length, 0);
  });

  it('GET /api/servers/:id/members — non-owner non-member → 403', async () => {
    const r = await memberClient.get(`/api/servers/${serverId}/members`);
    status(r, 403);
  });

  it('POST /api/servers/:id/members — add member', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/members`, {
      username: 'memMember',
      permissions: ['console'],
    });
    status(r, 200);
  });

  it('POST /api/servers/:id/members — add owner as member → 400', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/members`, {
      username: 'memOwner',
      permissions: ['console'],
    });
    status(r, 400);
  });

  it('POST /api/servers/:id/members — add nonexistent user → 404', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/members`, {
      username: 'ghost9999',
      permissions: [],
    });
    status(r, 404);
  });

  it('member can now access server', async () => {
    const r = await memberClient.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.id, serverId);
    // `shared` is only on the list endpoint; single-server GET just confirms access
    ok(r.body.owner_id !== memberId, 'member is not the owner');
  });

  it('GET /api/servers — member sees server as shared', async () => {
    const r = await memberClient.get('/api/servers');
    status(r, 200);
    const s = r.body.find(x => x.id === serverId);
    ok(s, 'member should see server');
    eq(s.shared, 1);
  });

  it('PATCH /api/servers/:id/members/:userId — update permissions', async () => {
    const r = await ownerClient.patch(`/api/servers/${serverId}/members/${memberId}`, {
      permissions: ['console', 'files'],
    });
    status(r, 200);
    const list = await ownerClient.get(`/api/servers/${serverId}/members`);
    const m = list.body.find(x => x.user_id === memberId);
    ok(m, 'member still in list');
    ok(m.permissions.includes('console'), 'console perm persisted');
    ok(m.permissions.includes('files'), 'files perm persisted');
  });

  it('DELETE /api/servers/:id/members/:userId — remove member', async () => {
    const r = await ownerClient.del(`/api/servers/${serverId}/members/${memberId}`);
    status(r, 200);
  });

  it('after removal — member cannot access server', async () => {
    const r = await memberClient.get(`/api/servers/${serverId}`);
    status(r, 403);
  });

  it('GET /api/servers/:id/members — list is empty again', async () => {
    const r = await ownerClient.get(`/api/servers/${serverId}/members`);
    status(r, 200);
    eq(r.body.length, 0);
  });
});
