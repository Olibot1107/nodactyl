'use strict';
// Tests for the audit log (admin-only) and per-server activity endpoint.
const { adminClient, makeClient, ensureMockNode, createServer, waitServerStatus, seedServer, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('audit.test.js', () => {
  let adm;
  let userClient;
  let userId;
  let serverId;
  let presetId;

  it('setup — register user, create preset, spin up server', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await ensureMockNode(adm.getToken());

    await adm.register('audituser', 'testpass123');
    const users = await adm.get('/api/users');
    userId = users.body.find(u => u.username === 'audituser').id;

    userClient = makeClient();
    await userClient.login('audituser', 'testpass123');

    // Create a preset the user can deploy (no rank required)
    const p = await adm.post('/api/presets', {
      name: 'audit-test-preset',
      image: 'alpine:latest',
      memory_limit: 128,
      cpu_limit: 0.25,
      startup_command: 'sh',
    });
    presetId = p.body.id;

    // Deploy from preset as non-admin — this generates an audit entry
    const deploy = await userClient.post('/api/servers/from-preset', {
      name: 'test-audit-server',
      preset_id: presetId,
    });
    status(deploy, 202);
    serverId = deploy.body.id;
    await waitServerStatus(adm.getToken(), serverId, 'stopped');
  });

  // ── Global audit log ──────────────────────────────────────────────────────────

  it('GET /api/audit — non-admin → 403', async () => {
    const r = await userClient.get('/api/audit');
    status(r, 403);
  });

  it('GET /api/audit — admin → paginated list', async () => {
    const r = await adm.get('/api/audit');
    status(r, 200);
    ok(Array.isArray(r.body.logs), 'logs array');
    hasField(r.body, 'total');
    hasField(r.body, 'limit');
    hasField(r.body, 'offset');
  });

  it('GET /api/audit — server.create entry exists from deploy', async () => {
    const r = await adm.get('/api/audit');
    status(r, 200);
    const entry = r.body.logs.find(l => l.action === 'server.create' && l.server_id === serverId);
    ok(entry, 'server.create audit entry should exist');
    eq(entry.user_id, userId);
    hasField(entry, 'metadata');
  });

  it('GET /api/audit — filter by user_id', async () => {
    const r = await adm.get(`/api/audit?user_id=${userId}`);
    status(r, 200);
    ok(r.body.logs.every(l => l.user_id === userId), 'all entries for this user');
  });

  it('GET /api/audit — filter by action prefix', async () => {
    const r = await adm.get('/api/audit?action=server');
    status(r, 200);
    ok(r.body.logs.every(l => l.action.startsWith('server')), 'all server.* actions');
    ok(r.body.logs.length > 0, 'should have entries');
  });

  it('GET /api/audit — filter by username', async () => {
    const r = await adm.get('/api/audit?username=audituser');
    status(r, 200);
    ok(r.body.logs.length > 0, 'should find entries for audituser');
    ok(r.body.logs.every(l => l.username === 'audituser'), 'all by audituser');
  });

  it('GET /api/audit — filter by server_id', async () => {
    const r = await adm.get(`/api/audit?server_id=${serverId}`);
    status(r, 200);
    ok(r.body.logs.every(l => l.server_id === serverId), 'all for this server');
  });

  it('GET /api/audit — respects limit/offset params', async () => {
    const r1 = await adm.get('/api/audit?limit=1');
    status(r1, 200);
    ok(r1.body.logs.length <= 1, 'max 1 entry');

    const r2 = await adm.get('/api/audit?limit=1&offset=0');
    const r3 = await adm.get('/api/audit?limit=1&offset=1');
    // Two pages should be different entries (assuming total > 1)
    if (r2.body.total > 1) {
      ok(r2.body.logs[0]?.id !== r3.body.logs[0]?.id, 'different entries on different pages');
    }
  });

  it('power action generates audit entry', async () => {
    // Non-admin performs a start → generates power.start audit entry
    await userClient.post(`/api/servers/${serverId}/action`, { action: 'start' });
    await waitServerStatus(adm.getToken(), serverId, 'running');

    const r = await adm.get(`/api/audit?server_id=${serverId}&action=power`);
    status(r, 200);
    ok(r.body.logs.length > 0, 'should have power action entries');
    ok(r.body.logs[0].action.startsWith('power.'), 'action is power.start');
  });

  it('settings change generates audit entry', async () => {
    const r = await userClient.patch(`/api/servers/${serverId}/settings`, { name: 'audit-renamed' });
    status(r, 200);

    const audit = await adm.get(`/api/audit?server_id=${serverId}&action=server.settings`);
    status(audit, 200);
    ok(audit.body.logs.length > 0, 'should have server.settings entry');
  });

  // ── Per-server activity ───────────────────────────────────────────────────────

  it('GET /api/servers/:id/activity — non-owner non-member → 403', async () => {
    await adm.register('stranger', 'testpass123');
    const c = makeClient();
    await c.login('stranger', 'testpass123');
    const r = await c.get(`/api/servers/${serverId}/activity`);
    status(r, 403);
  });

  it('GET /api/servers/:id/activity — owner gets list', async () => {
    const r = await userClient.get(`/api/servers/${serverId}/activity`);
    status(r, 200);
    ok(Array.isArray(r.body.logs), 'logs array');
    hasField(r.body, 'total');
    ok(r.body.total > 0, 'should have activity entries');
  });

  it('GET /api/servers/:id/activity — admin gets list', async () => {
    const r = await adm.get(`/api/servers/${serverId}/activity`);
    status(r, 200);
    ok(Array.isArray(r.body.logs));
  });

  it('GET /api/servers/:id/activity — respects limit param', async () => {
    const r = await adm.get(`/api/servers/${serverId}/activity?limit=1`);
    status(r, 200);
    ok(r.body.logs.length <= 1);
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  it('cleanup', async () => {
    if (serverId) await adm.del(`/api/servers/${serverId}`);
    if (presetId) await adm.del(`/api/presets/${presetId}`);
  });
});
