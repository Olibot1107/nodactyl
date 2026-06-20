const WebSocket = require('ws');
const nodePath = require('path');
const fs = require('fs');
const docker = require('./docker');
const hostfs = require('./hostfs');

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = nodePath.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json — copy config.example.json and fill it in');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { panelUrl, token, dataPath } = config;
// hostDataPath = the path Docker (on the host) uses for bind mounts.
// When running the daemon inside Docker, this must match what the HOST sees.
// Defaults to dataPath when running the daemon directly on the host.
const hostDataPath = config.hostDataPath || dataPath;

if (!panelUrl || !token) {
  console.error('config.json must have panelUrl and token');
  process.exit(1);
}

if (dataPath) {
  fs.mkdirSync(dataPath, { recursive: true });
  console.log(`[daemon] Data path: ${dataPath}${hostDataPath !== dataPath ? ` (host bind path: ${hostDataPath})` : ''}`);
} else {
  console.log('[daemon] No dataPath configured — file operations will use Docker archive fallback');
}

const DAEMON_WS = panelUrl.replace(/^http/, 'ws') + '/daemon';

// ── Helpers ───────────────────────────────────────────────────────────────────
function serverDataDir(serverId) {
  if (!dataPath || !serverId) return null;
  return nodePath.join(dataPath, serverId);
}

function hasDataDir(serverId) {
  const dir = serverDataDir(serverId);
  return dir ? fs.existsSync(dir) : false;
}

// Translate a container-style path (/home/container/...) to a host-relative path
// so hostfs can resolve it against the server's data directory.
const HOME_CONTAINER = '/home/container';
function toHostPath(containerPath) {
  const p = String(containerPath || HOME_CONTAINER).trim();
  if (p === HOME_CONTAINER || p === HOME_CONTAINER + '/') return '/';
  if (p.startsWith(HOME_CONTAINER + '/')) return p.slice(HOME_CONTAINER.length);
  return p; // already a root-relative path like '/' or '/subdir'
}

// ── State ─────────────────────────────────────────────────────────────────────
const activeLogStreams = new Map();
const pendingLogSubs = new Set(); // subscribe-logs in progress (guard against TOCTOU)
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

    const beat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) send({ type: 'heartbeat' });
      else clearInterval(beat);
    }, 15000);
  });

  ws.on('message', (raw) => handleMessage(JSON.parse(raw)));

  ws.on('close', (code) => {
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
      const { requestId, serverId, image, portMappings, envVars, memoryLimit, cpuLimit, startupCommand } = msg;
      console.log(`[server:${serverId.slice(0, 8)}] Installing — pulling ${image}...`);

      // Create persistent data directory before pulling image
      const binds = [];
      if (dataPath && serverId) {
        const dir = serverDataDir(serverId);
        fs.mkdirSync(dir, { recursive: true });
        // Use hostDataPath for the bind mount so Docker (on the host) can resolve it.
        // When the daemon runs inside Docker, dataPath is inside the container but
        // hostDataPath is the same path as seen by the Docker host.
        const hostDir = nodePath.join(hostDataPath, serverId);
        binds.push(`${hostDir}:/home/container`);
        console.log(`[server:${serverId.slice(0, 8)}] Data dir: ${dir} (bind: ${hostDir})`);
      }

      try {
        await docker.pullImage(image);
        console.log(`[server:${serverId.slice(0, 8)}] Image pulled — creating container`);
        const container = await docker.createContainer({
          serverId, image, portMappings, envVars, memoryLimit, cpuLimit,
          binds,
          startupCommand: startupCommand || '',
        });
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
      const { requestId, serverId, containerId, action, startupCommand, serverConfig } = msg;
      try {
        let activeContainerId = containerId;

        // On start, check if the startup command has changed or container is gone — recreate then.
        if (action === 'start' && serverConfig && startupCommand !== undefined) {
          let existingCommand = null;
          let containerExists = false;
          if (activeContainerId) {
            try {
              const info = await docker.docker.getContainer(activeContainerId).inspect();
              existingCommand = info.Config?.Labels?.['nodactyl.startup-command'] ?? null;
              containerExists = true;
            } catch { /* container gone or never created */ }
          }

          const commandChanged = (existingCommand ?? '') !== (startupCommand ?? '');
          if (commandChanged || !containerExists) {
            const binds = dataPath && serverId
              ? [`${nodePath.join(hostDataPath, serverId)}:/home/container`]
              : [];

            // Gracefully remove the old container
            try { await docker.containerAction(activeContainerId, 'stop'); } catch {}
            try { await docker.containerAction(activeContainerId, 'remove'); } catch {}

            const newContainer = await docker.createContainer({
              serverId,
              image: serverConfig.image,
              portMappings: serverConfig.portMappings || [],
              envVars: serverConfig.envVars || [],
              memoryLimit: serverConfig.memoryLimit || 512,
              cpuLimit: serverConfig.cpuLimit || 1.0,
              binds,
              startupCommand,
            });
            activeContainerId = newContainer.id;
          }
        }

        await docker.containerAction(activeContainerId, action);
        respond(requestId, { action, containerId: activeContainerId });
        // Status updates come from watchDockerEvents (die/start events) — no duplicate send here.
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'delete-server': {
      const { requestId, serverId, containerId } = msg;
      try {
        await docker.containerAction(containerId, 'remove');
        if (dataPath && serverId) {
          const dir = serverDataDir(serverId);
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`[server:${serverId.slice(0, 8)}] Data dir deleted: ${dir}`);
          }
        }
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'get-stats': {
      const { requestId, serverId, containerId } = msg;
      try {
        const stats = await docker.getStats(containerId);
        if (dataPath && serverId) {
          stats.diskUsed = hostfs.getDiskUsage(serverDataDir(serverId));
        }
        respond(requestId, stats);
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'inspect-container': {
      const { requestId, containerId } = msg;
      try {
        const info = await docker.getContainerInfo(containerId);
        respond(requestId, info);
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'subscribe-logs': {
      const { serverId, containerId, tail } = msg;
      if (activeLogStreams.has(serverId) || pendingLogSubs.has(serverId)) break;
      pendingLogSubs.add(serverId);
      try {
        const stream = await docker.streamLogs(containerId, (line) => {
          send({ type: 'log', serverId, line });
        }, tail !== undefined ? tail : 100);
        activeLogStreams.set(serverId, stream);
        stream.on('end', () => activeLogStreams.delete(serverId));
      } catch (err) {
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
      } finally {
        pendingLogSubs.delete(serverId);
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
        await docker.execCommand(containerId, command, (line) => {
          send({ type: 'log', serverId, line });
        });
      } catch (err) {
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
      }
      break;
    }

    // ── File operations ───────────────────────────────────────────────────────
    case 'list-files': {
      const { requestId, serverId, containerId, path: dirPath } = msg;
      try {
        let files;
        if (hasDataDir(serverId)) {
          files = hostfs.listFiles(serverDataDir(serverId), toHostPath(dirPath || HOME_CONTAINER));
        } else {
          files = await docker.listFiles(containerId, dirPath || HOME_CONTAINER);
        }
        respond(requestId, { files });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'read-file': {
      const { requestId, serverId, containerId, path: filePath } = msg;
      try {
        let content;
        if (hasDataDir(serverId)) {
          content = hostfs.readFile(serverDataDir(serverId), toHostPath(filePath));
        } else {
          content = await docker.readFile(containerId, filePath);
        }
        respond(requestId, { content });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'write-file': {
      const { requestId, serverId, containerId, path: filePath, content, encoding } = msg;
      try {
        if (hasDataDir(serverId)) {
          hostfs.writeFile(serverDataDir(serverId), toHostPath(filePath), content || '', encoding);
        } else {
          await docker.writeFile(containerId, filePath, content || '', encoding);
        }
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'mkdir': {
      const { requestId, serverId, containerId, path: dirPath } = msg;
      try {
        if (hasDataDir(serverId)) {
          hostfs.createDirectory(serverDataDir(serverId), toHostPath(dirPath));
        } else {
          await docker.createDirectory(containerId, dirPath);
        }
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'delete-file': {
      const { requestId, serverId, containerId, path: filePath } = msg;
      try {
        if (hasDataDir(serverId)) {
          const hostPath = toHostPath(filePath);
          if (hostPath === '/') { respond(requestId, {}, new Error('Cannot delete home directory')); break; }
          hostfs.deleteFile(serverDataDir(serverId), hostPath);
        } else {
          await docker.deleteFile(containerId, filePath);
        }
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'rename-file': {
      const { requestId, serverId, containerId, oldPath, newPath } = msg;
      try {
        if (hasDataDir(serverId)) {
          hostfs.renameFile(serverDataDir(serverId), toHostPath(oldPath), toHostPath(newPath));
        } else {
          await docker.renameFile(containerId, oldPath, newPath);
        }
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }
  }
}

// ── Docker event watcher ───────────────────────────────────────────────────────
// Streams container events so the panel learns about crashes immediately.
async function watchDockerEvents() {
  try {
    const stream = await new Promise((resolve, reject) => {
      docker.docker.getEvents({
        filters: JSON.stringify({
          type: ['container'],
          event: ['die', 'start'],
          label: ['nodactyl.managed=true'],
        }),
      }, (err, s) => err ? reject(err) : resolve(s));
    });

    let buf = '';
    stream.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const serverId = ev.Actor?.Attributes?.['nodactyl.server-id'];
          if (!serverId) continue;
          if (ev.Action === 'start') {
            console.log(`[server:${serverId.slice(0, 8)}] Container started — notifying panel`);
            send({ type: 'server-status', serverId, status: 'running' });
          } else {
            const exitCode = ev.Actor?.Attributes?.exitCode ?? ev.Actor?.Attributes?.ExitCode;
            console.log(`[server:${serverId.slice(0, 8)}] Container exited (code ${exitCode ?? '?'}) — notifying panel`);
            send({ type: 'server-status', serverId, status: 'stopped' });
            // Clean up any active log stream
            if (activeLogStreams.has(serverId)) {
              const logStream = activeLogStreams.get(serverId);
              if (logStream) { try { logStream.destroy(); } catch {} }
              activeLogStreams.delete(serverId);
            }
          }
        } catch {}
      }
    });

    stream.on('error', err => {
      console.error('[daemon] Docker events error:', err.message);
      setTimeout(watchDockerEvents, 5000);
    });
    stream.on('end', () => {
      console.warn('[daemon] Docker events stream ended — restarting');
      setTimeout(watchDockerEvents, 3000);
    });
  } catch (err) {
    console.error('[daemon] Docker events watch failed:', err.message);
    setTimeout(watchDockerEvents, 5000);
  }
}

connect();
watchDockerEvents();
