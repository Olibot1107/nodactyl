'use strict';
const { makeClient, adminClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('auth.test.js', () => {
  it('GET /api/auth/me — no token → 401', async () => {
    const c = makeClient();
    const r = await c.get('/api/auth/me');
    status(r, 401);
  });

  it('POST /api/auth/login — wrong password → 401', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/login', { username: 'admin', password: 'wrongpassword' });
    status(r, 401);
    ok(r.body.error, 'should have error message');
  });

  it('POST /api/auth/login — missing fields → 400', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/login', { username: 'admin' });
    status(r, 400);
  });

  it('POST /api/auth/login — valid credentials → token', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/login', { username: 'admin', password: 'admin' });
    status(r, 200);
    hasField(r.body, 'token');
    ok(r.body.token, 'token should be non-empty');
    hasField(r.body, 'user');
    eq(r.body.user.username, 'admin');
    eq(r.body.user.role, 'admin');
  });

  it('GET /api/auth/me — valid token → user info', async () => {
    const c = await adminClient();
    const r = await c.get('/api/auth/me');
    status(r, 200);
    eq(r.body.username, 'admin');
    eq(r.body.role, 'admin');
  });

  it('POST /api/auth/register — valid → 201', async () => {
    const adm = await adminClient();
    await reset(adm.getToken());

    const c = makeClient();
    const r = await c.post('/api/auth/register', {
      username: 'reguser1',
      email: 'reguser1@test.local',
      password: 'testpass123',
    });
    status(r, 201);
  });

  it('POST /api/auth/register — duplicate username → 400', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/register', {
      username: 'reguser1',
      email: 'other@test.local',
      password: 'testpass123',
    });
    status(r, 400);
  });

  it('POST /api/auth/register — short username → 400', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/register', {
      username: 'ab',
      email: 'ab@test.local',
      password: 'testpass123',
    });
    status(r, 400);
  });

  it('POST /api/auth/register — short password → 400', async () => {
    const c = makeClient();
    const r = await c.post('/api/auth/register', {
      username: 'validname',
      email: 'validname@test.local',
      password: 'short',
    });
    status(r, 400);
  });

  it('PATCH /api/auth/me — change username', async () => {
    const c = makeClient();
    await c.login('reguser1', 'testpass123');
    const r = await c.patch('/api/auth/me', { username: 'reguser1renamed' });
    status(r, 200);
    hasField(r.body, 'user');
    eq(r.body.user.username, 'reguser1renamed');
  });

  it('PATCH /api/auth/me — duplicate username → 400', async () => {
    const c = makeClient();
    await c.login('reguser1renamed', 'testpass123');
    const r = await c.patch('/api/auth/me', { username: 'admin' });
    status(r, 400);
  });

  it('POST /api/auth/logout — clears cookie', async () => {
    const c = await adminClient();
    const r = await c.post('/api/auth/logout');
    status(r, 200);
  });
});
