'use strict';
// Tests for log-shares and file-shares endpoints.
// Uses the public read endpoints too (no auth needed).
const { adminClient, makeClient, seedServer, reset, request } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('shares.test.js', () => {
  let adm;
  let ownerClient;
  let memberClient;
  let ownerId;
  let memberId;
  let serverId;
  let logShareId;
  let fileShareId;

  it('setup — create server, register a member', async () => {
    adm = await adminClient();
    await reset(adm.getToken());

    await adm.register('shareOwner', 'testpass123');
    await adm.register('shareMember', 'testpass123');

    const users = await adm.get('/api/users');
    ownerId = users.body.find(u => u.username === 'shareOwner').id;
    memberId = users.body.find(u => u.username === 'shareMember').id;

    ownerClient = makeClient();
    await ownerClient.login('shareOwner', 'testpass123');
    memberClient = makeClient();
    await memberClient.login('shareMember', 'testpass123');

    const seed = await seedServer(adm.getToken(), ownerId, 'test-shares-server');
    serverId = seed.serverId;
  });

  // ── Log shares ────────────────────────────────────────────────────────────────

  it('POST /:id/log-shares — no auth → 401', async () => {
    const r = await request('POST', `/api/servers/${serverId}/log-shares`, { content: 'hello' }, null);
    status(r, 401);
  });

  it('POST /:id/log-shares — non-member with no sharelog → 403', async () => {
    const r = await memberClient.post(`/api/servers/${serverId}/log-shares`, { content: 'hello' });
    status(r, 403);
  });

  it('POST /:id/log-shares — owner can create log share', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/log-shares`, {
      content: 'Server log line 1\nServer log line 2',
      label: 'Test log',
    });
    status(r, 200);
    hasField(r.body, 'id');
    hasField(r.body, 'expires_at');
    logShareId = r.body.id;
  });

  it('POST /:id/log-shares — missing content → 400', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/log-shares`, { label: 'Empty' });
    status(r, 400);
  });

  it('GET /:id/log-shares — owner sees the share', async () => {
    const r = await ownerClient.get(`/api/servers/${serverId}/log-shares`);
    status(r, 200);
    ok(Array.isArray(r.body));
    ok(r.body.some(s => s.id === logShareId), 'log share in list');
  });

  it('GET /:id/log-shares — non-member → 403', async () => {
    const r = await memberClient.get(`/api/servers/${serverId}/log-shares`);
    status(r, 403);
  });

  it('GET /api/log-shares/:shareId — public read (no auth)', async () => {
    const r = await request('GET', `/api/log-shares/${logShareId}`, null, null);
    status(r, 200);
    eq(r.body.id, logShareId);
    ok(typeof r.body.content === 'string', 'should have content');
    ok(r.body.content.includes('Server log line 1'), 'content matches');
    eq(r.body.label, 'Test log');
    ok(typeof r.body.view_count === 'number', 'has view_count');
  });

  it('GET /api/log-shares/:shareId — view_count increments', async () => {
    const r1 = await request('GET', `/api/log-shares/${logShareId}`, null, null);
    const r2 = await request('GET', `/api/log-shares/${logShareId}`, null, null);
    ok(r2.body.view_count > r1.body.view_count, 'view count should increment');
  });

  it('GET /api/log-shares/:shareId — nonexistent → 404', async () => {
    const r = await request('GET', '/api/log-shares/bad-id-nope', null, null);
    status(r, 404);
  });

  it('DELETE /:id/log-shares/:shareId — non-member → 403', async () => {
    const r = await memberClient.del(`/api/servers/${serverId}/log-shares/${logShareId}`);
    status(r, 403);
  });

  it('DELETE /:id/log-shares/:shareId — owner can delete', async () => {
    const r = await ownerClient.del(`/api/servers/${serverId}/log-shares/${logShareId}`);
    status(r, 200);
    ok(r.body.ok);
  });

  it('GET /api/log-shares/:shareId — after delete → 404', async () => {
    const r = await request('GET', `/api/log-shares/${logShareId}`, null, null);
    status(r, 404);
  });

  it('GET /:id/log-shares — list is empty after delete', async () => {
    const r = await ownerClient.get(`/api/servers/${serverId}/log-shares`);
    status(r, 200);
    ok(!r.body.some(s => s.id === logShareId), 'deleted share not in list');
  });

  // ── Member with sharelog perm ─────────────────────────────────────────────────

  it('member with sharelog perm can create log shares', async () => {
    // Add member with sharelog permission
    await ownerClient.post(`/api/servers/${serverId}/members`, {
      username: 'shareMember',
      permissions: ['sharelog'],
    });

    const r = await memberClient.post(`/api/servers/${serverId}/log-shares`, {
      content: 'Member log content',
      label: 'member-log',
    });
    status(r, 200);
    logShareId = r.body.id;
  });

  it('cleanup member log share', async () => {
    if (logShareId) await ownerClient.del(`/api/servers/${serverId}/log-shares/${logShareId}`);
    await ownerClient.del(`/api/servers/${serverId}/members/${memberId}`);
  });

  // ── File shares ───────────────────────────────────────────────────────────────

  it('POST /:id/file-shares — non-member without sharefile → 403', async () => {
    const r = await memberClient.post(`/api/servers/${serverId}/file-shares`, {
      content: 'file content here',
      file_path: '/home/container/config.yml',
    });
    status(r, 403);
  });

  it('POST /:id/file-shares — owner can create file share', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/file-shares`, {
      content: '# Config file\nkey: value\n',
      label: 'config.yml',
      file_path: '/home/container/config.yml',
      language: 'yaml',
    });
    status(r, 200);
    hasField(r.body, 'id');
    hasField(r.body, 'expires_at');
    fileShareId = r.body.id;
  });

  it('POST /:id/file-shares — missing content → 400', async () => {
    const r = await ownerClient.post(`/api/servers/${serverId}/file-shares`, { label: 'empty' });
    status(r, 400);
  });

  it('GET /:id/file-shares — owner sees the share', async () => {
    const r = await ownerClient.get(`/api/servers/${serverId}/file-shares`);
    status(r, 200);
    ok(Array.isArray(r.body));
    const share = r.body.find(s => s.id === fileShareId);
    ok(share, 'file share in list');
    eq(share.label, 'config.yml');
    eq(share.language, 'yaml');
  });

  it('GET /api/file-shares/:shareId — public read (no auth)', async () => {
    const r = await request('GET', `/api/file-shares/${fileShareId}`, null, null);
    status(r, 200);
    eq(r.body.id, fileShareId);
    ok(r.body.content.includes('key: value'), 'content matches');
    eq(r.body.label, 'config.yml');
    eq(r.body.language, 'yaml');
  });

  it('GET /api/file-shares/:shareId — nonexistent → 404', async () => {
    const r = await request('GET', '/api/file-shares/bad-id', null, null);
    status(r, 404);
  });

  it('DELETE /:id/file-shares/:shareId — owner can delete', async () => {
    const r = await ownerClient.del(`/api/servers/${serverId}/file-shares/${fileShareId}`);
    status(r, 200);
    ok(r.body.ok);
  });

  it('GET /api/file-shares/:shareId — after delete → 404', async () => {
    const r = await request('GET', `/api/file-shares/${fileShareId}`, null, null);
    status(r, 404);
  });
});
