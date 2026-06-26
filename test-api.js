/**
 * Nodactyl v1 API test script
 * Usage: node test-api.js
 *
 * Requires Node 18+ (uses built-in fetch).
 *
 * Environment vars:
 *   API_KEY     — your ndl_... key (required)
 *   BASE_URL    — panel URL (default: http://localhost:3000)
 *   DESTRUCTIVE — set to "true" to enable write/delete/power tests
 *   BURST       — set to "true" to run the rate-limit burst test
 *                 (will exhaust your per-minute quota for this key)
 */

const BASE_URL    = process.env.BASE_URL   || 'http://localhost:3000';
const API_KEY     = process.env.API_KEY    || 'ndl_your_key_here';
const DESTRUCTIVE = process.env.DESTRUCTIVE === 'true';
const BURST       = process.env.BURST      === 'true';

// ── Helpers ───────────────────────────────────────────────────────────────────

const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', dim:'\x1b[2m', bold:'\x1b[1m' };
let passed = 0, failed = 0, skipped = 0;

function log(sym, col, label, detail = '') {
  console.log(`  ${col}${sym}${C.reset} ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`);
}
function pass(label, detail)  { passed++;  log('✓', C.green,  label, detail); }
function fail(label, detail)  { failed++;  log('✗', C.red,    label, detail); }
function skip(label, reason)  { skipped++; log('–', C.yellow, label, `(skipped: ${reason})`); }
function section(title)       { console.log(`\n${C.bold}${C.cyan}${title}${C.reset}`); }

async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE_URL + '/api/v1' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

function expect(label, condition, detail) {
  if (condition) pass(label, detail);
  else           fail(label, detail);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Auth ──────────────────────────────────────────────────────────────────────

async function testAuth() {
  section('Auth');
  const r1 = await fetch(BASE_URL + '/api/v1/servers').then(r => r.json());
  expect('Rejects request with no key', r1.error?.includes('Missing'), JSON.stringify(r1));
  const r2 = await fetch(BASE_URL + '/api/v1/servers', { headers: { 'X-API-Key': 'ndl_badkey' } }).then(r => r.json());
  expect('Rejects invalid key', r2.error?.includes('Invalid'), JSON.stringify(r2));
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function testNodes() {
  section('GET /nodes');
  const { status, data } = await req('GET', '/nodes');
  expect('Returns 200',       status === 200, `status=${status}`);
  expect('Returns an array',  Array.isArray(data), typeof data);
  if (Array.isArray(data) && data.length) {
    expect('Node has id',     !!data[0].id);
    expect('Node has online', 'online' in data[0]);
    pass(`Found ${data.length} node(s)`, data.map(n => `${n.name}(${n.online ? 'online' : 'offline'})`).join(', '));
  }
  return Array.isArray(data) ? data : [];
}

// ── Presets & templates ───────────────────────────────────────────────────────

async function testPresets() {
  section('GET /presets');
  const { status, data } = await req('GET', '/presets');
  expect('Returns 200',       status === 200, `status=${status}`);
  expect('Returns an array',  Array.isArray(data), typeof data);
  if (Array.isArray(data) && data.length) {
    const p = data[0];
    expect('Preset has id',       !!p.id);
    expect('Preset has image',    !!p.image);
    expect('env_vars is array',   Array.isArray(p.env_vars));
    pass(`Found ${data.length} preset(s)`, data.map(p => p.name).join(', '));

    const r2 = await req('GET', `/presets/${p.id}`);
    expect('GET /presets/:id returns 200', r2.status === 200);
  } else {
    pass('No presets in panel');
  }
  const r404 = await req('GET', '/presets/00000000-0000-0000-0000-000000000000');
  expect('Returns 404 for unknown preset', r404.status === 404);
  return Array.isArray(data) ? data : [];
}

async function testTemplates() {
  section('GET /templates');
  const { status, data } = await req('GET', '/templates');
  expect('Returns 200',       status === 200, `status=${status}`);
  expect('Returns an array',  Array.isArray(data), typeof data);
  if (Array.isArray(data) && data.length) {
    pass(`Found ${data.length} template(s)`, data.map(t => t.name).join(', '));
    const r2 = await req('GET', `/templates/${data[0].id}`);
    expect('GET /templates/:id returns 200', r2.status === 200);
  } else {
    pass('No templates in panel');
  }
  return Array.isArray(data) ? data : [];
}

// ── Servers ───────────────────────────────────────────────────────────────────

async function testServers() {
  section('GET /servers');
  const { status, data } = await req('GET', '/servers');
  expect('Returns 200',         status === 200, `status=${status}`);
  expect('Returns an array',    Array.isArray(data), typeof data);
  if (Array.isArray(data) && data.length) {
    const s = data[0];
    expect('Has id',            !!s.id);
    expect('Has status',        !!s.status);
    expect('port_mappings arr', Array.isArray(s.port_mappings));
    expect('env_vars arr',      Array.isArray(s.env_vars));
    expect('node_online bool',  typeof s.node_online === 'boolean');
    pass(`Found ${data.length} server(s)`, data.map(s => `${s.name}(${s.status})`).join(', '));
  }
  return Array.isArray(data) ? data : [];
}

async function testServerById(id) {
  section('GET /servers/:id');
  const { status, data } = await req('GET', `/servers/${id}`);
  expect('Returns 200',             status === 200, `status=${status}`);
  expect('Id matches',              data.id === id);
  const r2 = await req('GET', '/servers/00000000-0000-0000-0000-000000000000');
  expect('404 for unknown server',  r2.status === 404, `status=${r2.status}`);
  return data;
}

async function testStats(id) {
  section('GET /servers/:id/stats');
  const { status, data } = await req('GET', `/servers/${id}/stats`);
  expect('Returns 200',      status === 200, `status=${status}`);
  expect('Has cpu field',    'cpu'    in data);
  expect('Has memory field', 'memory' in data);
}

async function testRateLimitHeaders(id) {
  section('Rate limit headers');
  const { headers } = await req('GET', `/servers/${id}`);
  const lm = headers.get('x-ratelimit-limit-min');
  const rm = headers.get('x-ratelimit-remaining-min');
  const lh = headers.get('x-ratelimit-limit-hour');
  const rh = headers.get('x-ratelimit-remaining-hour');
  expect('X-RateLimit-Limit-Min',      lm !== null, lm);
  expect('X-RateLimit-Remaining-Min',  rm !== null, rm);
  expect('X-RateLimit-Limit-Hour',     lh !== null, lh);
  expect('X-RateLimit-Remaining-Hour', rh !== null, rh);
  if (lm && rm) pass(`Minute window:  ${rm}/${lm} remaining`);
  if (lh && rh) pass(`Hour window:    ${rh}/${lh} remaining`);
  return { remainingMin: parseInt(rm ?? '999'), limitMin: parseInt(lm ?? '60') };
}

// ── Power ─────────────────────────────────────────────────────────────────────

async function testAction(id, serverStatus) {
  section('POST /servers/:id/action');
  if (!DESTRUCTIVE) { skip('Power action', 'set DESTRUCTIVE=true to enable'); return; }
  const action = serverStatus === 'running' ? 'stop' : 'start';
  const { status, data } = await req('POST', `/servers/${id}/action`, { action });
  expect(`${action} returns 200`,  status === 200, `status=${status}`);
  expect('Returns { ok: true }',   data.ok === true);
}

async function testBadAction(id) {
  section('POST /servers/:id/action  (invalid)');
  const { status, data } = await req('POST', `/servers/${id}/action`, { action: 'explode' });
  expect('400 for invalid action',  status === 400, `status=${status}`);
  expect('Error message present',   !!data.error, data.error);
}

async function testStdin(id, serverStatus) {
  section('POST /servers/:id/stdin');
  if (!DESTRUCTIVE)               { skip('stdin', 'set DESTRUCTIVE=true to enable'); return; }
  if (serverStatus !== 'running') { skip('stdin', 'server is not running'); return; }
  const { status } = await req('POST', `/servers/${id}/stdin`, { data: 'echo hello\n' });
  expect('Returns 200', status === 200, `status=${status}`);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function testSettings(id, originalName) {
  section('PATCH /servers/:id/settings');
  if (!DESTRUCTIVE) { skip('settings patch', 'set DESTRUCTIVE=true to enable'); return; }
  const { status, data } = await req('PATCH', `/servers/${id}/settings`, { name: originalName + '-apitest' });
  expect('Returns 200',   status === 200, `status=${status}`);
  expect('Name updated',  data.name === originalName + '-apitest', data.name);
  await req('PATCH', `/servers/${id}/settings`, { name: originalName });
  pass('Name restored', originalName);
}

// ── Activity ──────────────────────────────────────────────────────────────────

async function testActivity(id) {
  section('GET /servers/:id/activity');
  const { status, data } = await req('GET', `/servers/${id}/activity?limit=10`);
  expect('Returns 200',        status === 200, `status=${status}`);
  expect('Has logs array',     Array.isArray(data.logs));
  expect('Has total field',    typeof data.total === 'number', String(data.total));
  expect('Has limit field',    data.limit === 10);
  if (data.logs?.length) {
    const l = data.logs[0];
    expect('Log has action',     !!l.action);
    expect('Log has created_at', !!l.created_at);
    expect('Metadata is object', typeof l.metadata === 'object');
    pass(`${data.total} total audit entries`);
  } else {
    pass('Activity log empty');
  }
  const p2 = await req('GET', `/servers/${id}/activity?limit=5&offset=0`);
  expect('Pagination works', p2.status === 200 && Array.isArray(p2.data.logs));
}

// ── Members ───────────────────────────────────────────────────────────────────

async function testMembers(id) {
  section('GET /servers/:id/members');
  const { status, data } = await req('GET', `/servers/${id}/members`);
  expect('Returns 200',      status === 200, `status=${status}`);
  expect('Returns array',    Array.isArray(data));
  pass(`Found ${data.length} member(s)`);

  const r400 = await req('POST', `/servers/${id}/members`, { username: '' });
  expect('POST empty username → 400', r400.status === 400);
  const r404 = await req('POST', `/servers/${id}/members`, { username: '__nonexistent_user_xyz__' });
  expect('POST unknown user → 404',   r404.status === 404);
}

// ── Files ─────────────────────────────────────────────────────────────────────

async function testFiles(id, nodeOnline) {
  section('File operations');
  if (!nodeOnline) { skip('All file tests', 'node is offline'); return; }

  const list = await req('GET', `/servers/${id}/files`);
  expect('List / returns 200',      list.status === 200, `status=${list.status}`);
  expect('Response has files key',  Array.isArray(list.data?.files), typeof list.data?.files);
  pass(`Root has ${list.data?.files?.length ?? 0} item(s)`);

  if (!DESTRUCTIVE) { skip('Write/read/delete/rename/mkdir', 'set DESTRUCTIVE=true to enable'); return; }

  const testPath    = '/home/container/.nodactyl-api-test.txt';
  const testContent = 'API test ' + Date.now();

  const wr = await req('PUT',  `/servers/${id}/files/write`, { path: testPath, content: testContent });
  expect('Write returns 200', wr.status === 200, `status=${wr.status}`);

  const rd = await req('GET', `/servers/${id}/files/read?path=${encodeURIComponent(testPath)}`);
  expect('Read returns 200',  rd.status === 200, `status=${rd.status}`);
  expect('Content matches',   rd.data?.content === testContent, rd.data?.content?.slice(0, 40));

  const rb = await req('GET', `/servers/${id}/files/read-binary?path=${encodeURIComponent(testPath)}`);
  expect('Read-binary returns 200', rb.status === 200);
  expect('Read-binary has content', !!rb.data?.content);

  const dirPath = '/home/container/.nodactyl-api-testdir';
  expect('Mkdir returns 200',  (await req('POST', `/servers/${id}/files/mkdir`, { path: dirPath })).status === 200);

  const newPath = '/home/container/.nodactyl-api-test-renamed.txt';
  expect('Rename returns 200', (await req('POST', `/servers/${id}/files/rename`, { oldPath: testPath, newPath })).status === 200);
  expect('Delete file → 200',  (await req('DELETE', `/servers/${id}/files?path=${encodeURIComponent(newPath)}`)).status === 200);
  expect('Delete dir → 200',   (await req('DELETE', `/servers/${id}/files?path=${encodeURIComponent(dirPath)}`)).status === 200);
  expect('Missing file → 404', (await req('GET',    `/servers/${id}/files/read?path=/home/container/.nodactyl-nonexistent`)).status === 404);
}

// ── Create from preset then delete ───────────────────────────────────────────

async function testCreateAndDelete(presets, templates) {
  section('POST /servers/from-preset  →  DELETE /servers/:id');

  if (!DESTRUCTIVE) {
    skip('Server create + delete', 'set DESTRUCTIVE=true to enable');
    return;
  }

  // Pick a preset or template to use
  const preset   = presets[0]   || null;
  const template = templates[0] || null;

  if (!preset && !template) {
    skip('Server create + delete', 'no presets or templates in panel');
    return;
  }

  let createdId = null;

  if (preset) {
    const { status, data } = await req('POST', '/servers/from-preset', {
      name: 'api-test-throwaway',
      preset_id: preset.id,
    });
    expect('from-preset returns 202',    status === 202, `status=${status}`);
    expect('Response has id',            !!data.id);
    expect('Status is installing',       data.status === 'installing');
    expect('Has port_mappings',          Array.isArray(data.port_mappings));
    if (data.id) {
      createdId = data.id;
      pass(`Created server ${createdId.slice(0, 8)}… from preset "${preset.name}"`);
    }
  } else {
    const { status, data } = await req('POST', '/servers/from-template', {
      name: 'api-test-throwaway',
      template_id: template.id,
    });
    expect('from-template returns 202',  status === 202, `status=${status}`);
    expect('Response has id',            !!data.id);
    expect('Status is installing',       data.status === 'installing');
    if (data.id) {
      createdId = data.id;
      pass(`Created server ${createdId.slice(0, 8)}… from template "${template.name}"`);
    }
  }

  if (!createdId) { fail('No server id returned — skipping delete'); return; }

  // Verify it shows up in GET /servers
  const list = await req('GET', '/servers');
  expect('Server appears in list', list.data?.some?.(s => s.id === createdId));

  // Delete it
  const del = await req('DELETE', `/servers/${createdId}`);
  expect('DELETE returns 200',     del.status === 200, `status=${del.status}`);
  expect('Returns { ok: true }',   del.data?.ok === true, JSON.stringify(del.data));

  // Confirm it's gone
  const check = await req('GET', `/servers/${createdId}`);
  expect('Server is gone (404)',   check.status === 404, `status=${check.status}`);
  pass('Throwaway server cleaned up');

  // Test validation errors
  const b1 = await req('POST', '/servers/from-preset', { preset_id: 'some-id' });
  expect('Missing name → 400',   b1.status === 400, `status=${b1.status}`);
  const b2 = await req('POST', '/servers/from-preset', { name: 'x', preset_id: '00000000-0000-0000-0000-000000000000' });
  expect('Unknown preset → 404', b2.status === 404, `status=${b2.status}`);
}

// ── Rate limit burst test ─────────────────────────────────────────────────────

async function testRateLimitEnforcement(remainingMin) {
  section('Rate limit enforcement');

  if (!BURST) {
    skip('Burst test', 'set BURST=true to enable (exhausts per-minute quota for this key)');
    console.log(`  ${C.dim}  When enabled: sends ${remainingMin + 2} requests to trigger a 429${C.reset}`);
    return;
  }

  const toSend = remainingMin + 2;
  console.log(`  ${C.dim}  Sending ${toSend} rapid requests (${remainingMin} remaining + 2 extra)…${C.reset}`);

  let got429 = false;
  let last429At = 0;
  let retryAfter = null;

  for (let i = 0; i < toSend; i++) {
    const r = await req('GET', '/nodes');
    if (r.status === 429) {
      got429 = true;
      last429At = i + 1;
      retryAfter = r.headers.get('retry-after');
      break;
    }
  }

  expect('429 returned when limit exceeded', got429, got429 ? `on request #${last429At}` : 'never hit 429');
  if (got429) {
    expect('Retry-After header present', retryAfter !== null, retryAfter);
    pass(`Rate limit kicked in at request #${last429At}`, `Retry-After: ${retryAfter}s`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}Nodactyl API Test${C.reset}`);
  console.log(`${C.dim}  Panel:  ${BASE_URL}`);
  console.log(`  Key:    ${API_KEY.slice(0, 12)}…`);
  console.log(`  Mode:   ${[
    DESTRUCTIVE ? 'destructive' : 'read-only',
    BURST       ? 'burst'       : '',
  ].filter(Boolean).join(' + ')}${C.reset}`);

  if (API_KEY === 'ndl_your_key_here') {
    console.log(`\n${C.red}  ERROR: Set API_KEY before running.${C.reset}`);
    console.log(`  ${C.dim}Example:  $env:API_KEY="ndl_..."; node test-api.js${C.reset}\n`);
    process.exit(1);
  }

  let remainingMin = 58;

  try {
    await testAuth();
    await testNodes();
    const presets   = await testPresets();
    const templates = await testTemplates();
    const servers   = await testServers();

    if (!servers.length) {
      console.log(`\n${C.yellow}  No servers found — skipping per-server tests.${C.reset}`);
    } else {
      const s = servers[0];
      await testServerById(s.id);
      await testStats(s.id);
      const rl = await testRateLimitHeaders(s.id);
      remainingMin = rl.remainingMin;
      await testAction(s.id, s.status);
      await testBadAction(s.id);
      await testStdin(s.id, s.status);
      await testSettings(s.id, s.name);
      await testActivity(s.id);
      await testMembers(s.id);
      await testFiles(s.id, s.node_online);
    }

    await testCreateAndDelete(presets, templates);
    await testRateLimitEnforcement(remainingMin);

  } catch (err) {
    console.error(`\n${C.red}  Unexpected error: ${err.message}${C.reset}`);
    if (err.cause?.code === 'ECONNREFUSED')
      console.error(`  ${C.dim}Is the panel running at ${BASE_URL}?${C.reset}`);
  }

  console.log(`\n${'─'.repeat(44)}`);
  console.log(`  ${C.green}${passed} passed${C.reset}  ${failed ? C.red : C.dim}${failed} failed${C.reset}  ${C.yellow}${skipped} skipped${C.reset}\n`);
  if (failed) process.exit(1);
}

main();
