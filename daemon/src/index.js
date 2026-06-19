const WebSocket = require('ws');
const docker = require('./docker');
const path = require('path');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json — copy config.example.json and fill it in');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { panelUrl, token } = config;
if (!panelUrl || !token) {
  console.error('config.json must have panelUrl and token');
  process.exit(1);
}

const DAEMON_WS = panelUrl.replace(/^http/, 'ws') + '/daemon';

// ── State ─────────────────────────────────────────────────────────────────────
const activeLogStreams = new Map(); // serverId → stream
let ws;
let reconnectDelay = 3000;

// ── Connect ───────────────────────────────────────────────────────────────────
function connect() {
  console.log(`[daemon] Connecting to ${DAEMON_WS} ...`);
  ws = new WebSocket(DAEMON_WS);

  ws.on('open', () => {
    reconnectDelay = 3000;
    console.log('[daemon] Connected — authenticating...');
    send({ type: 'auth', token });

    // Heartbeat every 15s
    const beat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send({ type: 'heartbeat' });
      else clearInterval(beat);
    }, 15000);
  });

  ws.on('message', (raw) => handleMessage(JSON.parse(raw)));

  ws.on('close', (code, reason) => {
    console.log(`[daemon] Disconnected (${code}) — reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err) => console.error('[daemon] WS error:', err.message));
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function respond(requestId, data = {}, error = null) {
  send({ type: 'response', requestId, success: !error, data, error: error?.message || error });
}

// ── Message handlers ──────────────────────────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth-result': {
      if (msg.success) console.log(`[daemon] Authenticated as node "${msg.name}"`);
      else { console.error('[daemon] Auth failed:', msg.error); process.exit(1); }
      break;
    }

    case 'install-server': {
      const { requestId, serverId, image, portMappings, envVars, memoryLimit, cpuLimit } = msg;
      console.log(`[server:${serverId.slice(0, 8)}] Installing — pulling ${image}...`);
      try {
        await docker.pullImage(image);
        console.log(`[server:${serverId.slice(0, 8)}] Image pulled — creating container`);
        const container = await docker.createContainer({ serverId, image, portMappings, envVars, memoryLimit, cpuLimit });
        respond(requestId, { containerId: container.id });
        send({ type: 'server-status', serverId, status: 'stopped' });
        console.log(`[server:${serverId.slice(0, 8)}] Installed ✓`);
      } catch (err) {
        console.error(`[server:${serverId.slice(0, 8)}] Install failed:`, err.message);
        respond(requestId, {}, err);
        send({ type: 'server-status', serverId, status: 'error' });
      }
      break;
    }

    case 'server-action': {
      const { requestId, serverId, containerId, action } = msg;
      try {
        await docker.containerAction(containerId, action);
        respond(requestId, { action });
        const status = (action === 'start' || action === 'restart') ? 'running' : 'stopped';
        send({ type: 'server-status', serverId, status });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'delete-server': {
      const { requestId, serverId, containerId } = msg;
      try {
        await docker.containerAction(containerId, 'remove');
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'get-stats': {
      const { requestId, containerId } = msg;
      try {
        const stats = await docker.getStats(containerId);
        respond(requestId, stats);
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'subscribe-logs': {
      const { serverId, containerId } = msg;
      if (activeLogStreams.has(serverId)) break;

      try {
        const stream = await docker.streamLogs(containerId, (line) => {
          send({ type: 'log', serverId, line });
        });
        activeLogStreams.set(serverId, stream);
        stream.on('end', () => activeLogStreams.delete(serverId));
      } catch (err) {
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
      }
      break;
    }

    case 'unsubscribe-logs': {
      const { serverId } = msg;
      const stream = activeLogStreams.get(serverId);
      if (stream) { try { stream.destroy(); } catch {} activeLogStreams.delete(serverId); }
      break;
    }

    case 'exec': {
      const { serverId, containerId, command } = msg;
      try {
        const output = await docker.execCommand(containerId, command);
        send({ type: 'log', serverId, line: output });
      } catch (err) {
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
      }
      break;
    }
  }
}

connect();
