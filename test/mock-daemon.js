'use strict';
// Lightweight daemon simulator for integration tests.
// Connects to the panel via WebSocket, authenticates with a node token,
// and responds to all panel commands with synthetic success replies.
// Real Docker is never involved — containers get fake IDs.

const path = require('path');
// Reuse the ws package that the panel already has installed
const WS = require(path.join(__dirname, '..', 'panel', 'node_modules', 'ws'));

function mockContainerId(serverId) {
  return 'mockc-' + serverId.slice(0, 12);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Start a mock daemon connected to the panel at panelWsUrl with nodeToken.
 * Returns { disconnect } when the daemon is authenticated and ready.
 */
function startMockDaemon(panelWsUrl, nodeToken) {
  return new Promise((resolve, reject) => {
    const ws = new WS(panelWsUrl);
    let ready = false;
    let beatInterval = null;

    function send(msg) {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(msg));
    }

    function respond(requestId, data, error) {
      send({ type: 'response', requestId, success: !error, data: data || {}, error: error || null });
    }

    ws.on('open', () => {
      send({ type: 'auth', token: nodeToken });
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth-result') {
        if (!msg.success) {
          ws.close();
          return reject(new Error('Mock daemon auth failed: ' + msg.error));
        }
        // Heartbeat every 14s (panel expects one every 15s)
        beatInterval = setInterval(() => send({ type: 'heartbeat' }), 14000);
        // Notify the panel we have no containers (clean slate)
        send({ type: 'containers-synced', serverIds: [] });
        ready = true;
        return resolve({ disconnect: () => { clearInterval(beatInterval); ws.close(); } });
      }

      if (!ready) return;

      switch (msg.type) {
        case 'install-server': {
          const { requestId, serverId, installScript } = msg;
          // Simulate install taking ~50ms
          await sleep(50);
          // If there's an install script, emit log lines
          if (installScript) {
            send({ type: 'log', serverId, line: '[mock-daemon] Running install script...\n' });
            await sleep(10);
            send({ type: 'log', serverId, line: '[mock-daemon] Install complete.\n' });
          }
          respond(requestId, { containerId: mockContainerId(serverId) });
          break;
        }

        case 'server-action': {
          const { requestId, serverId, action } = msg;
          const containerId = mockContainerId(serverId);
          await sleep(20);
          respond(requestId, { containerId });
          // Push a status update so tests can wait for the expected status
          if (action === 'start' || action === 'restart') {
            send({ type: 'server-status', serverId, status: 'running', containerId });
          } else if (action === 'stop' || action === 'kill' || action === 'sigterm' || action === 'sigint') {
            send({ type: 'server-status', serverId, status: 'stopped', containerId });
          }
          break;
        }

        case 'delete-server': {
          respond(msg.requestId, {});
          break;
        }

        case 'get-stats': {
          respond(msg.requestId, { cpu: 0.5, memory: 64, memoryLimit: msg.memoryLimit || 512, disk: 0 });
          break;
        }

        case 'subscribe-logs':
        case 'unsubscribe-logs':
          // No response expected for these
          break;

        default:
          // Anything else: respond success so tests don't hang
          if (msg.requestId) respond(msg.requestId, {});
      }
    });

    ws.on('error', (err) => {
      if (!ready) reject(err);
    });

    ws.on('close', () => {
      clearInterval(beatInterval);
    });

    // Fail fast if panel doesn't respond in 5s
    setTimeout(() => {
      if (!ready) {
        ws.close();
        reject(new Error('Mock daemon auth timed out'));
      }
    }, 5000);
  });
}

module.exports = { startMockDaemon };
