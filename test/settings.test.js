'use strict';
const { adminClient, makeClient, reset } = require('./helpers');
const { status, ok, eq, hasField } = require('./assert');

describe('settings.test.js', () => {
  let adm;

  it('setup', async () => {
    adm = await adminClient();
    await reset(adm.getToken());
  });

  it('GET /api/settings/public — no auth required', async () => {
    const { request } = require('./helpers');
    const r = await request('GET', '/api/settings/public', null, null);
    status(r, 200);
    ok(typeof r.body === 'object');
  });

  it('GET /api/settings — non-admin → 403', async () => {
    await adm.register('settuser', 'testpass123');
    const c = makeClient();
    await c.login('settuser', 'testpass123');
    const r = await c.get('/api/settings');
    status(r, 403);
  });

  it('GET /api/settings — admin → key-value map', async () => {
    const r = await adm.get('/api/settings');
    status(r, 200);
    ok(typeof r.body === 'object', 'should be object');
    hasField(r.body, 'panel_name');
  });

  it('PATCH /api/settings — set panel_name', async () => {
    const r = await adm.patch('/api/settings', { panel_name: 'TestPanel' });
    status(r, 200);
    const get = await adm.get('/api/settings');
    eq(get.body.panel_name, 'TestPanel');
  });

  it('PATCH /api/settings — restore panel_name', async () => {
    const r = await adm.patch('/api/settings', { panel_name: 'Nodactyl' });
    status(r, 200);
  });

  it('PATCH /api/settings — invalid keys are silently ignored (by design)', async () => {
    // The route skips invalid keys rather than rejecting the whole request.
    // Valid keys in the same payload should still be processed.
    const r = await adm.patch('/api/settings', { UPPERCASE_KEY: 'val', panel_name: 'StillUpdated' });
    status(r, 200);
    const get = await adm.get('/api/settings');
    eq(get.body.panel_name, 'StillUpdated');
    ok(!('UPPERCASE_KEY' in get.body), 'invalid key should not be stored');
    await adm.patch('/api/settings', { panel_name: 'Nodactyl' });
  });

  it('PATCH /api/settings — set panel_logo', async () => {
    const r = await adm.patch('/api/settings', { panel_logo: 'T' });
    status(r, 200);
    const get = await adm.get('/api/settings');
    eq(get.body.panel_logo, 'T');
    await adm.patch('/api/settings', { panel_logo: 'N' });
  });

  it('PATCH /api/settings — non-admin → 403', async () => {
    const c = makeClient();
    await c.login('settuser', 'testpass123');
    const r = await c.patch('/api/settings', { panel_name: 'Hacked' });
    status(r, 403);
  });
});
