'use strict';
const { adminClient, makeClient, seedServer, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('transfer.test.js', () => {
  let adm;
  let userA;   // original owner
  let userB;   // transfer recipient (regular user)
  let userAId, userBId, adminId;
  let serverId;
  let rankId;  // rank with max_servers = 1

  it('setup — register users + create rank', async () => {
    adm = await adminClient();
    await reset(adm.getToken());

    await adm.register('transferA', 'testpass123');
    await adm.register('transferB', 'testpass123');

    const users = await adm.get('/api/users');
    userAId = users.body.find(u => u.username === 'transferA').id;
    userBId = users.body.find(u => u.username === 'transferB').id;
    adminId = users.body.find(u => u.username === 'admin').id;

    // Give userA and userB a rank with max 1 server
    const rr = await adm.post('/api/ranks', { name: 'TransferRank', max_servers: 1, sort_order: 55 });
    rankId = rr.body.id;
    await adm.patch(`/api/users/${userAId}/rank`, { rank_id: rankId });
    await adm.patch(`/api/users/${userBId}/rank`, { rank_id: rankId });

    userA = makeClient();
    await userA.login('transferA', 'testpass123');
    userB = makeClient();
    await userB.login('transferB', 'testpass123');
  });

  it('seed — create server owned by userA', async () => {
    const seed = await seedServer(adm.getToken(), userAId, 'test-transfer-server');
    serverId = seed.serverId;
    ok(serverId, 'should have serverId');
  });

  // ── Initiation ────────────────────────────────────────────────────────────────

  it('POST /:id/transfer — non-owner non-admin → 403', async () => {
    const r = await userB.post(`/api/servers/${serverId}/transfer`, { username: 'transferB' });
    status(r, 403);
  });

  it('POST /:id/transfer — unknown target → 404', async () => {
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'nobody999' });
    status(r, 404);
  });

  it('POST /:id/transfer — transfer to self → 400', async () => {
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'transferA' });
    status(r, 400);
  });

  it('POST /:id/transfer — valid initiation by owner', async () => {
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'transferB' });
    status(r, 200);
    ok(r.body.ok, 'should return ok');
  });

  // ── Pending check ─────────────────────────────────────────────────────────────

  it('GET /servers/transfers/incoming — userB sees pending transfer', async () => {
    const r = await userB.get('/api/servers/transfers/incoming');
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    ok(r.body.some(s => s.id === serverId), 'should see the pending server');
  });

  it('GET /servers/transfers/incoming — userA sees nothing (they initiated, not receiving)', async () => {
    const r = await userA.get('/api/servers/transfers/incoming');
    status(r, 200);
    ok(!r.body.some(s => s.id === serverId), 'initiator should not see it in incoming');
  });

  // ── Cancel & re-initiate ──────────────────────────────────────────────────────

  it('DELETE /:id/transfer — owner can cancel', async () => {
    const r = await userA.del(`/api/servers/${serverId}/transfer`);
    status(r, 200);
  });

  it('GET /servers/transfers/incoming — cancelled transfer gone', async () => {
    const r = await userB.get('/api/servers/transfers/incoming');
    status(r, 200);
    ok(!r.body.some(s => s.id === serverId), 'cancelled transfer not visible');
  });

  // ── Full accept flow ──────────────────────────────────────────────────────────

  it('POST /:id/transfer — re-initiate transfer to userB', async () => {
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'transferB' });
    status(r, 200);
  });

  it('POST /:id/transfer/accept — userA cannot accept (not the recipient)', async () => {
    const r = await userA.post(`/api/servers/${serverId}/transfer/accept`);
    status(r, 403);
  });

  it('POST /:id/transfer/accept — userB accepts', async () => {
    const r = await userB.post(`/api/servers/${serverId}/transfer/accept`);
    status(r, 200);
    ok(r.body.ok);
  });

  it('after accept — userB owns the server', async () => {
    const r = await userB.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.id, serverId);
    // owner_id should now be userB's id
    eq(r.body.owner_id, userBId);
  });

  it('after accept — userA cannot access server anymore', async () => {
    const r = await userA.get(`/api/servers/${serverId}`);
    status(r, 403);
  });

  it('after accept — userA server list is empty (slot freed)', async () => {
    const r = await userA.get('/api/servers');
    status(r, 200);
    ok(!r.body.some(s => s.id === serverId), 'transferred server not in old owner list');
    eq(r.body.length, 0, 'userA should have 0 servers');
  });

  // ── Decline flow — use admin as recipient (they bypass rank limits) ───────────

  it('setup second server for decline test', async () => {
    const seed = await seedServer(adm.getToken(), userAId, 'test-decline-server');
    serverId = seed.serverId;
    // Transfer to admin (who has no rank-based server limit)
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'admin' });
    status(r, 200);
  });

  it('POST /:id/transfer/decline — admin declines', async () => {
    const r = await adm.post(`/api/servers/${serverId}/transfer/decline`);
    status(r, 200);
  });

  it('after decline — userA still owns server', async () => {
    const r = await userA.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.id, serverId);
    eq(r.body.owner_id, userAId);
  });

  // ── BUG FIX: Admin transferring to themselves bypasses rank limit ──────────────

  it('bug-fix: admin initiates transfer to themselves (should NOT hit rank limit)', async () => {
    // If admin had a rank with max_servers=1 and already owned servers, old code would block this.
    // We confirm the initiation to admin bypasses rank checks entirely.
    const r = await userA.post(`/api/servers/${serverId}/transfer`, { username: 'admin' });
    status(r, 200, 'admin recipient should bypass rank limit check');
  });

  it('bug-fix: admin accepts transfer regardless of rank limit', async () => {
    const r = await adm.post(`/api/servers/${serverId}/transfer/accept`);
    status(r, 200, 'admin should accept regardless of rank-based server count');
    ok(r.body.ok);
  });

  it('after admin accept — admin owns the server', async () => {
    const r = await adm.get(`/api/servers/${serverId}`);
    status(r, 200);
    eq(r.body.owner_id, adminId);
  });

  it('after admin accept — previous owner (userA) has 0 servers', async () => {
    const r = await userA.get('/api/servers');
    status(r, 200);
    eq(r.body.length, 0, 'userA should own 0 servers after transfer to admin');
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  it('cleanup', async () => {
    await adm.del(`/api/ranks/${rankId}`);
  });
});
