'use strict';
// Tests for the REST API v1 (/api/v1/*) which uses API key authentication.
const { adminClient, makeClient, ensureMockNode, createServer, waitServerStatus, reset, request, BASE_URL } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');
const http = require('http');
const { URL } = require('url');

// v1 uses X-API-Key header, NOT Authorization: Bearer
function v1Request(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey || '' };
    if (!apiKey) delete headers['X-API-Key']; // omit header for no-auth tests
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const parsed = new URL(BASE_URL);
    const req = http.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port),
      path,
      method,
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function makeApiKeyClient(apiKey) {
  return {
    get:  (p)    => v1Request('GET',    p, null,   apiKey),
    post: (p, b) => v1Request('POST',   p, b || {}, apiKey),
    del:  (p)    => v1Request('DELETE', p, null,   apiKey),
  };
}

describe('v1api.test.js', () => {
  let adm;
  let userClient;
  let userId;
  let serverId;
  let adminKey;
  let userKey;
  let adminApiClient;
  let userApiClient;

  it('setup — create user + node, register server', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
    await ensureMockNode(adm.getToken());

    await adm.register('v1user', 'testpass123');
    const users = await adm.get('/api/users');
    userId = users.body.find(u => u.username === 'v1user').id;

    userClient = makeClient();
    await userClient.login('v1user', 'testpass123');

    // Create a server owned by the user
    serverId = await createServer(adm.getToken(), userId, 'test-v1-server');

    // Create API keys
    const ar = await adm.post('/api/apikeys', { name: 'admin-v1-key' });
    adminKey = ar.body.key;
    adminApiClient = makeApiKeyClient(adminKey);

    const ur = await userClient.post('/api/apikeys', { name: 'user-v1-key' });
    userKey = ur.body.key;
    userApiClient = makeApiKeyClient(userKey);
  });

  // ── Authentication guard ──────────────────────────────────────────────────────

  it('GET /api/v1/servers — no X-API-Key → 401', async () => {
    const r = await v1Request('GET', '/api/v1/servers', null, null);
    status(r, 401);
  });

  it('GET /api/v1/servers — JWT Bearer token → 401 (v1 only accepts X-API-Key)', async () => {
    // Simulate sending a JWT in the old Authorization: Bearer header — v1 ignores it
    const r = await request('GET', '/api/v1/servers', null, adm.getToken());
    status(r, 401);
  });

  // ── Nodes ─────────────────────────────────────────────────────────────────────

  it('GET /api/v1/nodes — user key → list of nodes', async () => {
    const r = await userApiClient.get('/api/v1/nodes');
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    ok(r.body.length > 0, 'at least one node');
    const node = r.body[0];
    hasField(node, 'id');
    hasField(node, 'online');
  });

  // ── Server listing ────────────────────────────────────────────────────────────

  it('GET /api/v1/servers — user sees own servers', async () => {
    const r = await userApiClient.get('/api/v1/servers');
    status(r, 200);
    ok(Array.isArray(r.body));
    ok(r.body.some(s => s.id === serverId), 'own server in list');
  });

  it('GET /api/v1/servers — admin sees all servers', async () => {
    const r = await adminApiClient.get('/api/v1/servers');
    status(r, 200);
    ok(Array.isArray(r.body));
    ok(r.body.some(s => s.id === serverId), 'all servers visible to admin');
  });

  it('GET /api/v1/servers/:id — user can get own server', async () => {
    const r = await userApiClient.get(`/api/v1/servers/${serverId}`);
    status(r, 200);
    eq(r.body.id, serverId);
    hasField(r.body, 'port_mappings');
    hasField(r.body, 'node_online');
  });

  it('GET /api/v1/servers/:id — unknown server → 404', async () => {
    const r = await userApiClient.get('/api/v1/servers/bad-id');
    status(r, 404);
  });

  // ── Stats ─────────────────────────────────────────────────────────────────────

  it('GET /api/v1/servers/:id/stats — stopped server → 200 with status', async () => {
    const r = await userApiClient.get(`/api/v1/servers/${serverId}/stats`);
    status(r, 200);
    ok(typeof r.body.cpu !== 'undefined' || r.body.status === 'stopped', 'has stat fields');
  });

  // ── Power actions ─────────────────────────────────────────────────────────────

  it('POST /api/v1/servers/:id/action — invalid action → 400', async () => {
    const r = await userApiClient.post(`/api/v1/servers/${serverId}/action`, { action: 'explode' });
    status(r, 400);
  });

  it('POST /api/v1/servers/:id/action — start server', async () => {
    const r = await userApiClient.post(`/api/v1/servers/${serverId}/action`, { action: 'start' });
    status(r, 200);
    ok(r.body.ok);
    await waitServerStatus(adm.getToken(), serverId, 'running');
  });

  it('GET /api/v1/servers/:id/stats — running server → live stats', async () => {
    const r = await userApiClient.get(`/api/v1/servers/${serverId}/stats`);
    status(r, 200);
    ok(typeof r.body.cpu !== 'undefined', 'has cpu stat');
    ok(typeof r.body.memory !== 'undefined', 'has memory stat');
  });

  it('POST /api/v1/servers/:id/action — stop server', async () => {
    const r = await userApiClient.post(`/api/v1/servers/${serverId}/action`, { action: 'stop' });
    status(r, 200);
    await waitServerStatus(adm.getToken(), serverId, 'stopped');
  });

  // ── Access control ────────────────────────────────────────────────────────────

  it('GET /api/v1/servers/:id — other user API key → 403', async () => {
    await adm.register('v1stranger', 'testpass123');
    const c = makeClient();
    await c.login('v1stranger', 'testpass123');
    const kr = await c.post('/api/apikeys', { name: 'stranger-key' });
    const strangerClient = makeApiKeyClient(kr.body.key);

    const r = await strangerClient.get(`/api/v1/servers/${serverId}`);
    status(r, 403);
  });

  // ── Delete via v1 ─────────────────────────────────────────────────────────────

  it('DELETE /api/v1/servers/:id — other user → 403', async () => {
    const c = makeClient();
    await c.login('v1stranger', 'testpass123');
    const kr = await c.post('/api/apikeys', { name: 'del-key' });
    const strangerClient = makeApiKeyClient(kr.body.key);
    const r = await strangerClient.del(`/api/v1/servers/${serverId}`);
    status(r, 403);
  });

  it('DELETE /api/v1/servers/:id — owner via API key → 200', async () => {
    const r = await userApiClient.del(`/api/v1/servers/${serverId}`);
    status(r, 200);
    ok(r.body.ok);
  });

  it('GET /api/v1/servers/:id — after delete → 404', async () => {
    const r = await userApiClient.get(`/api/v1/servers/${serverId}`);
    status(r, 404);
  });
});
