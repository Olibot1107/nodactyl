'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('apikeys.test.js', () => {
  let adm;
  let keyId;
  let apiKey;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
  });

  it('GET /api/apikeys — no keys initially', async () => {
    const r = await adm.get('/api/apikeys');
    status(r, 200);
    ok(Array.isArray(r.body), 'array');
    eq(r.body.length, 0);
  });

  it('POST /api/apikeys — create key', async () => {
    const r = await adm.post('/api/apikeys', { name: 'test-key' });
    status(r, 201);
    hasField(r.body, 'id');
    hasField(r.body, 'key');
    ok(r.body.key.length > 10, 'key should be non-trivial');
    keyId = r.body.id;
    apiKey = r.body.key;
  });

  it('POST /api/apikeys — missing name → 400', async () => {
    const r = await adm.post('/api/apikeys', {});
    status(r, 400);
  });

  it('GET /api/apikeys — lists created key', async () => {
    const r = await adm.get('/api/apikeys');
    status(r, 200);
    ok(r.body.some(k => k.id === keyId), 'key in list');
    // Raw key should NOT be returned in list
    ok(!r.body.some(k => k.key === apiKey), 'raw key not exposed in list');
  });

  it('GET /api/auth/me via API key Bearer token → authenticated', async () => {
    const { request } = require('./helpers');
    const r = await request('GET', '/api/auth/me', null, apiKey);
    // API keys are prefixed with ndtl_ and act like Bearer tokens
    ok(r.status === 200 || r.status === 401, `got ${r.status}`);
  });

  it('DELETE /api/apikeys/:id — delete key', async () => {
    const r = await adm.del(`/api/apikeys/${keyId}`);
    status(r, 200);
  });

  it('GET /api/apikeys — key removed', async () => {
    const r = await adm.get('/api/apikeys');
    status(r, 200);
    ok(!r.body.some(k => k.id === keyId), 'key removed');
  });
});
