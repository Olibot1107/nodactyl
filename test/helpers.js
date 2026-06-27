'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startMockDaemon } = require('./mock-daemon');

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PANEL_DIR = path.join(__dirname, '..', 'panel');
const DB_PATH = path.join(os.tmpdir(), `nodactyl-test-${process.pid}.db`);

let _proc = null;
let _daemon = null; // { disconnect }
let _nodeId = null;

// ── Server lifecycle ──────────────────────────────────────────────────────────

async function startServer() {
  if (_proc) return;

  // Clean slate
  try { fs.unlinkSync(DB_PATH); } catch {}

  _proc = spawn(process.execPath, ['src/index.js'], {
    cwd: PANEL_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(TEST_PORT),
      JWT_SECRET: 'test-secret-nodactyl',
      REGISTRATION_OPEN: 'true',
      DB_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  _proc.stdout.on('data', () => {}); // drain
  _proc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.error('  [panel]', line);
  });

  _proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`  Panel process exited with code ${code}`);
    }
  });

  await waitReady();
}

async function stopServer() {
  if (_daemon) {
    try { _daemon.disconnect(); } catch {}
    _daemon = null;
    _nodeId = null;
  }
  if (!_proc) return;
  _proc.kill();
  _proc = null;
  try { fs.unlinkSync(DB_PATH); } catch {}
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request('GET', '/api/auth/me', null, null);
      return; // any response (even 401) means it's up
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Panel did not become ready within ' + timeoutMs + 'ms');
}

// ── Mock daemon & real node ──────────────────────────────────────────────────

/**
 * Create a real node via the API and connect a mock daemon to it.
 * Call this once per test run (usually in the first describe's setup).
 * Returns the nodeId so tests can reference it.
 */
async function ensureMockNode(adminTok) {
  if (_nodeId) return _nodeId;

  // Create the node via the real API — name matches 'test-node-%' so reset() cleans it up
  const r = await request('POST', '/api/nodes', {
    name: 'test-node-mock',
    memory: 8192,
    cpu: 8,
    port_range_start: 20000,
    port_range_end: 25000,
  }, adminTok);

  if (r.status !== 201) throw new Error('Failed to create test node: ' + JSON.stringify(r.body));

  const { id: nodeId, token: nodeToken } = r.body;

  // Connect the mock daemon
  const panelWsUrl = `ws://localhost:${TEST_PORT}/daemon`;
  _daemon = await startMockDaemon(panelWsUrl, nodeToken);

  // Wait for node to appear online (panel sets status=online on daemon heartbeat)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const nr = await request('GET', `/api/nodes/${nodeId}`, null, adminTok);
    if (nr.body?.online) break;
    await sleep(200);
  }

  _nodeId = nodeId;
  return nodeId;
}

/**
 * Create a real server via POST /api/servers (admin endpoint).
 * Requires ensureMockNode() to have been called first.
 * Waits for status to become 'stopped' (install complete) before returning.
 */
async function createServer(adminTok, ownerId, name, opts = {}) {
  const nodeId = _nodeId;
  if (!nodeId) throw new Error('Call ensureMockNode() before createServer()');

  const r = await request('POST', '/api/servers', {
    name,
    image: opts.image || 'alpine:latest',
    node_id: nodeId,
    owner_id: ownerId,
    memory_limit: opts.memory_limit || 256,
    cpu_limit: opts.cpu_limit || 0.5,
    startup_command: opts.startup_command || 'sh',
  }, adminTok);

  if (r.status !== 202) throw new Error('createServer failed: ' + JSON.stringify(r.body));
  const serverId = r.body.id;

  // Wait for install to complete (mock daemon replies almost immediately)
  await waitServerStatus(adminTok, serverId, 'stopped', 10000);
  return serverId;
}

/**
 * Poll GET /api/servers/:id until status === targetStatus or timeout.
 */
async function waitServerStatus(tok, serverId, targetStatus, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request('GET', `/api/servers/${serverId}`, null, tok);
    if (r.body?.status === targetStatus) return;
    await sleep(200);
  }
  throw new Error(`Server ${serverId} did not reach status '${targetStatus}' within ${timeoutMs}ms`);
}

// ── HTTP client ───────────────────────────────────────────────────────────────

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
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

/** Simple API wrapper that tracks a token per session */
function makeClient(initialToken) {
  let token = initialToken || null;

  async function call(method, path, body) {
    return request(method, path, body, token);
  }

  return {
    get: (p) => call('GET', p, null),
    post: (p, b) => call('POST', p, b || {}),
    patch: (p, b) => call('PATCH', p, b || {}),
    put: (p, b) => call('PUT', p, b || {}),
    del: (p) => call('DELETE', p, null),
    getToken: () => token,
    setToken: (t) => { token = t; },

    async login(username, password) {
      const r = await call('POST', '/api/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`Login failed for ${username}: ${r.body?.error || r.status}`);
      token = r.body.token;
      return r.body;
    },

    async register(username, password, email) {
      email = email || `${username}@test.local`;
      const r = await call('POST', '/api/auth/register', { username, email, password });
      if (r.status !== 201) throw new Error(`Register failed for ${username}: ${r.body?.error || r.status}`);
      return r.body;
    },
  };
}

/** Admin client — pre-logged-in as the seeded admin */
async function adminClient() {
  const c = makeClient();
  await c.login('admin', 'admin');
  return c;
}

/** Seed a server owned by ownerId using the fast test-only route. Returns { nodeId, serverId }. */
async function seedServer(adminTok, ownerId, name) {
  const r = await request('POST', '/api/test/seed', { owner_id: ownerId, name: name || 'test-server' }, adminTok);
  if (r.status !== 200) throw new Error('Seed failed: ' + JSON.stringify(r.body));
  return r.body;
}

/** Reset test state (remove non-admin users and their servers). */
async function reset(adminTok) {
  _nodeId = null; // mock node gets deleted too
  if (_daemon) {
    try { _daemon.disconnect(); } catch {}
    _daemon = null;
  }
  await request('POST', '/api/test/reset', {}, adminTok);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  startServer, stopServer,
  makeClient, adminClient,
  seedServer, reset, request, BASE_URL,
  ensureMockNode, createServer, waitServerStatus, sleep,
};
