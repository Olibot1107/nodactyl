const WebSocket = require('ws');
const nodePath = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
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

// ── CPU sampling ─────────────────────────────────────────────────────────────
// Two /proc/stat reads 250 ms apart give an accurate delta-based CPU %.
// Falls back to os.cpus() snapshot (less accurate) on non-Linux systems.
async function getCpuPercent() {
  function readProcStat() {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const nums = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = nums[3] + (nums[4] || 0);
      const total = nums.reduce((a, b) => a + b, 0);
      return { idle, total };
    } catch { return null; }
  }
  const a = readProcStat();
  if (!a) {
    const cpus = os.cpus();
    let idle = 0, tick = 0;
    for (const c of cpus) { for (const t in c.times) tick += c.times[t]; idle += c.times.idle; }
    return tick > 0 ? Math.round((1 - idle / tick) * 100) : 0;
  }
  await new Promise(r => setTimeout(r, 250));
  const b = readProcStat();
  if (!b || b.total === a.total) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100)));
}

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
// Map of serverId → { stream, containerId } so we can detect stale streams by container ID
const activeLogStreams = new Map();
const pendingLogSubs = new Set();
let ownNodeId = null; // set on auth-result; used to ignore Docker events from other daemons
// Ground truth: what container is currently running for each server.
// Updated on every start action and Docker start event so subscribe-logs
// always attaches to the real live container, not whatever stale ID the panel DB has.
const activeContainers = new Map(); // serverId → containerId
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { console.error('[daemon] Received non-JSON message, ignoring'); return; }
    handleMessage(msg);
  });

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

// If /home/container/packages exists (populated by pip --target), inject PYTHONPATH so
// installed packages are importable without any user-side configuration.
function envWithPythonPath(serverId, envVars) {
  if (!dataPath || !serverId) return envVars || [];
  const packagesDir = nodePath.join(serverDataDir(serverId), 'packages');
  if (!fs.existsSync(packagesDir)) return envVars || [];
  const list = envVars || [];
  const existing = list.find(e => e.key === 'PYTHONPATH');
  if (existing) {
    return list.map(e => e.key === 'PYTHONPATH'
      ? { ...e, value: `/home/container/packages:${e.value}` }
      : e);
  }
  return [...list, { key: 'PYTHONPATH', value: '/home/container/packages' }];
}


// ── Message handlers ──────────────────────────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth-result': {
      if (msg.success) {
        ownNodeId = msg.nodeId;
        console.log(`[daemon] Authenticated as node "${msg.name}" (${ownNodeId})`);
      } else { console.error('[daemon] Auth failed:', msg.error); process.exit(1); }
      break;
    }

    case 'install-server': {
      const { requestId, serverId, image, portMappings, envVars, memoryLimit, cpuLimit, startupCommand, installScript } = msg;
      console.log(`[server:${serverId.slice(0, 8)}] Installing — pulling ${image}...`);

      // Create persistent data directory before pulling image
      const binds = [];
      if (dataPath && serverId) {
        const dir = serverDataDir(serverId);
        fs.mkdirSync(dir, { recursive: true });
        const hostDir = nodePath.join(hostDataPath, serverId);
        binds.push(`${hostDir}:/home/container`);
        console.log(`[server:${serverId.slice(0, 8)}] Data dir: ${dir} (bind: ${hostDir})`);
      }

      try {
        await docker.pullImage(image);
        console.log(`[server:${serverId.slice(0, 8)}] Image pulled`);

        // Run install script in a temporary container if provided
        if (installScript && installScript.trim()) {
          console.log(`[server:${serverId.slice(0, 8)}] Running install script...`);
          send({ type: 'log', serverId, line: '\r\n\x1b[33m[Nodactyl] Running install script...\x1b[0m\r\n' });

          const memBytes = (memoryLimit || 512) * 1024 * 1024;
          const installContainer = await docker.docker.createContainer({
            Image: image,
            Cmd: ['/bin/sh', '-c', installScript],
            WorkingDir: '/home/container',
            Env: (envVars || []).map(e => `${e.key}=${e.value}`),
            HostConfig: {
              Binds: binds,
              Memory: memBytes,
              MemorySwap: memBytes * 2,
              NanoCpus: Math.floor((cpuLimit || 1) * 1e9),
            },
          });

          // Attach before start so no output is missed
          const attachStream = await installContainer.attach({ stream: true, stdout: true, stderr: true });
          attachStream.on('data', chunk => {
            let offset = 0;
            while (offset + 8 <= chunk.length) {
              const size = chunk.readUInt32BE(offset + 4);
              const end = offset + 8 + size;
              if (end > chunk.length) break;
              const text = chunk.slice(offset + 8, end).toString('utf8');
              if (text) send({ type: 'log', serverId, line: text });
              offset = end;
            }
            if (offset === 0) {
              const text = chunk.toString('utf8');
              if (text) send({ type: 'log', serverId, line: text });
            }
          });

          await installContainer.start();
          const { StatusCode: exitCode } = await installContainer.wait();
          try { await installContainer.remove({ force: true }); } catch {}

          if (exitCode !== 0) {
            send({ type: 'log', serverId, line: `\r\n\x1b[31m[Nodactyl] Install script failed (exit ${exitCode}).\x1b[0m\r\n` });
            console.error(`[server:${serverId.slice(0, 8)}] Install script failed (exit ${exitCode})`);
            respond(requestId, {}, new Error(`Install script failed (exit ${exitCode})`));
            send({ type: 'server-status', serverId, status: 'error' });
            break;
          }

          send({ type: 'log', serverId, line: '\r\n\x1b[32m[Nodactyl] Install complete. Setting up server container...\x1b[0m\r\n' });
          console.log(`[server:${serverId.slice(0, 8)}] Install script done ✓`);
        }

        const container = await docker.createContainer({
          serverId, nodeId: ownNodeId, image, portMappings,
          envVars: envWithPythonPath(serverId, envVars),
          memoryLimit, cpuLimit, binds,
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

        // Always recreate the container on start so each run has a fresh log history.
        // Docker logs accumulate across stop/start cycles on the same container, causing
        // startup output to repeat in the panel console on every restart.
        // The bind-mounted data directory (/home/container) survives across recreations.
        if (action === 'start' && serverConfig) {
          const binds = dataPath && serverId
            ? [`${nodePath.join(hostDataPath, serverId)}:/home/container`]
            : [];

          try { await docker.containerAction(activeContainerId, 'stop'); } catch {}
          try { await docker.containerAction(activeContainerId, 'remove'); } catch {}

          const newContainer = await docker.createContainer({
            serverId,
            nodeId: ownNodeId,
            image: serverConfig.image,
            portMappings: serverConfig.portMappings || [],
            envVars: envWithPythonPath(serverId, serverConfig.envVars || []),
            memoryLimit: serverConfig.memoryLimit || 512,
            cpuLimit: serverConfig.cpuLimit || 1.0,
            binds,
            startupCommand: startupCommand || '',
          });
          activeContainerId = newContainer.id;
          activeContainers.set(serverId, activeContainerId);
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
      // Container removal is best-effort — it may already be gone
      if (containerId) {
        try { await docker.containerAction(containerId, 'remove'); } catch {}
      }
      // Always clean up the data dir regardless of whether the container existed
      if (dataPath && serverId) {
        const dir = serverDataDir(serverId);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[server:${serverId.slice(0, 8)}] Data dir deleted: ${dir}`);
        }
      }
      respond(requestId, {});
      break;
    }

    case 'get-stats': {
      const { requestId, serverId, containerId } = msg;
      try {
        const stats = await docker.getStats(containerId);
        if (dataPath && serverId) {
          const hostDisk = hostfs.getDiskUsage(serverDataDir(serverId));
          // Sum hostfs data dir + container writable overlay layer
          stats.diskUsed = hostDisk + (stats.containerDiskUsed || 0);
        } else if (stats.containerDiskUsed) {
          stats.diskUsed = stats.containerDiskUsed;
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
      const { serverId, tail } = msg;
      // Use the daemon's own knowledge of the active container rather than whatever
      // container ID the panel sent — the panel DB may still hold the old ID due to
      // async Promise resolution racing with the Socket.IO delivery.
      const containerId = activeContainers.get(serverId) || msg.containerId;
      if (!containerId) break;

      // If there's an existing stream for a DIFFERENT container, it's stale — replace it.
      const existing = activeLogStreams.get(serverId);
      if (existing) {
        if (existing.containerId === containerId) break;
        try { existing.stream.destroy(); } catch {}
        activeLogStreams.delete(serverId);
      }

      if (pendingLogSubs.has(serverId)) break;
      pendingLogSubs.add(serverId);
      try {
        const stream = await docker.streamLogs(containerId, (line) => {
          send({ type: 'log', serverId, line });
        }, tail !== undefined ? tail : 100);
        activeLogStreams.set(serverId, { stream, containerId });
        stream.on('end', () => {
          const cur = activeLogStreams.get(serverId);
          if (cur?.containerId === containerId) activeLogStreams.delete(serverId);
        });
      } catch (err) {
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
      } finally {
        pendingLogSubs.delete(serverId);
      }
      break;
    }

    case 'unsubscribe-logs': {
      const { serverId } = msg;
      const entry = activeLogStreams.get(serverId);
      if (entry) { try { entry.stream.destroy(); } catch {} activeLogStreams.delete(serverId); }
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

    case 'install-package': {
      const { requestId, serverId, image, envVars, memoryLimit, manager, pkg } = msg;
      const isManifest = !pkg || pkg.trim() === '';
      // pkg='' → install from manifest file (package.json, requirements.txt, etc.)
      // pip installs to --target so packages land in the bind-mounted /home/container/packages
      // and survive container recreation. PYTHONPATH is injected automatically on server start.
      const CMDS = {
        npm:      isManifest ? ['npm', 'install']                                                                    : ['npm', 'install', pkg],
        yarn:     isManifest ? ['yarn', 'install']                                                                   : ['yarn', 'add', pkg],
        pip:      isManifest ? ['pip',  'install', '--target', '/home/container/packages', '-r', 'requirements.txt'] : ['pip',  'install', '--target', '/home/container/packages', pkg],
        pip3:     isManifest ? ['pip3', 'install', '--target', '/home/container/packages', '-r', 'requirements.txt'] : ['pip3', 'install', '--target', '/home/container/packages', pkg],
        composer: isManifest ? ['composer', 'install']                                                               : ['composer', 'require', pkg],
        gem:      isManifest ? null                                                                                  : ['gem', 'install', pkg],
        cargo:    isManifest ? ['cargo', 'build']                                                                    : ['cargo', 'add', pkg],
      };
      if (!CMDS[manager]) {
        respond(requestId, {}, new Error(isManifest ? `${manager} does not support manifest installs` : `Unknown package manager: ${manager}`));
        break;
      }
      let pkgContainer = null;
      try {
        const binds = dataPath && serverId ? [`${nodePath.join(hostDataPath, serverId)}:/home/container`] : [];
        const memBytes = (memoryLimit || 512) * 1024 * 1024;

        send({ type: 'log', serverId, line: `\r\n\x1b[33m[Nodactyl] Running: ${CMDS[manager].join(' ')}\x1b[0m\r\n` });

        pkgContainer = await docker.docker.createContainer({
          Image: image,
          Cmd: CMDS[manager],
          WorkingDir: '/home/container',
          Env: (envVars || []).map(e => `${e.key}=${e.value}`),
          HostConfig: { Binds: binds, Memory: memBytes, MemorySwap: memBytes },
        });

        const attachStream = await pkgContainer.attach({ stream: true, stdout: true, stderr: true });
        attachStream.on('data', chunk => {
          let offset = 0;
          while (offset + 8 <= chunk.length) {
            const size = chunk.readUInt32BE(offset + 4);
            const end = offset + 8 + size;
            if (end > chunk.length) break;
            const text = chunk.slice(offset + 8, end).toString('utf8');
            if (text) send({ type: 'log', serverId, line: text });
            offset = end;
          }
        });

        await pkgContainer.start();

        const { StatusCode: exitCode } = await Promise.race([
          pkgContainer.wait(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Package install timed out after 5 minutes')), 300000)),
        ]);

        try { await pkgContainer.remove({ force: true }); } catch {}
        pkgContainer = null;

        if (exitCode !== 0) {
          send({ type: 'log', serverId, line: `\r\n\x1b[31m[Nodactyl] Package install failed (exit ${exitCode}).\x1b[0m\r\n` });
          respond(requestId, {}, new Error(`Package install failed with exit code ${exitCode}`));
        } else {
          send({ type: 'log', serverId, line: `\r\n\x1b[32m[Nodactyl] Package install complete.\x1b[0m\r\n` });
          respond(requestId, { ok: true });
        }
      } catch (err) {
        if (pkgContainer) { try { await pkgContainer.remove({ force: true }); } catch {} }
        send({ type: 'log', serverId, line: `[Error: ${err.message}]\n` });
        respond(requestId, {}, err);
      }
      break;
    }

    case 'send-stdin': {
      const { requestId, containerId, data } = msg;
      try {
        const c = docker.docker.getContainer(containerId);
        const stream = await c.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
        stream.write(Buffer.from(data, 'binary'));
        stream.end();
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
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

    case 'read-file-binary': {
      const { requestId, serverId, containerId, path: filePath } = msg;
      try {
        let content;
        if (hasDataDir(serverId)) {
          content = hostfs.readFileBinary(serverDataDir(serverId), toHostPath(filePath));
        } else {
          content = await docker.readFileBinary(containerId, filePath);
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

    case 'extract-archive': {
      const { requestId, serverId, containerId, path: archivePath, dest: destDir } = msg;
      try {
        const low = (archivePath || '').toLowerCase();

        // Run a command, throw a clean error on failure or missing executable
        const runCmd = (cmd, args, opts = {}) => {
          const r = spawnSync(cmd, args, { timeout: 120000, encoding: 'utf8', ...opts });
          if (r.error) {
            if (r.error.code === 'ENOENT') throw new Error(`${cmd} is not installed on this node`);
            throw r.error;
          }
          if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${cmd} failed`).trim());
          return (r.stdout + (r.stderr || '')).trim();
        };

        // Try cmd, if not found try fallback, if neither throw msg
        const runWithFallback = (primary, fallback, notFoundMsg) => {
          const r = spawnSync(primary.cmd, primary.args, { timeout: 120000, encoding: 'utf8' });
          if (!r.error) {
            if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${primary.cmd} failed`).trim());
            return (r.stdout + (r.stderr || '')).trim();
          }
          if (r.error.code !== 'ENOENT') throw r.error;
          // primary not found — try fallback
          const r2 = spawnSync(fallback.cmd, fallback.args, { timeout: 120000, encoding: 'utf8' });
          if (!r2.error) {
            if (r2.status !== 0) throw new Error((r2.stderr || r2.stdout || `${fallback.cmd} failed`).trim());
            return (r2.stdout + (r2.stderr || '')).trim();
          }
          if (r2.error.code !== 'ENOENT') throw r2.error;
          throw new Error(notFoundMsg);
        };

        if (hasDataDir(serverId)) {
          const dataDir = serverDataDir(serverId);
          const hostArchive = toHostPath(archivePath);
          const hostDest = destDir ? toHostPath(destDir) : nodePath.dirname(toHostPath(archivePath));
          const archiveFull = hostfs.safePath(dataDir, hostArchive);
          const destFull = hostfs.safePath(dataDir, hostDest);
          if (!fs.existsSync(archiveFull)) throw new Error('Archive not found');
          fs.mkdirSync(destFull, { recursive: true });
          console.log(`[server:${serverId.slice(0,8)}] Extracting ${nodePath.basename(archiveFull)}`);

          let output;
          if (low.endsWith('.zip')) {
            output = runWithFallback(
              { cmd: 'unzip', args: ['-o', archiveFull, '-d', destFull] },
              { cmd: 'python3', args: ['-m', 'zipfile', '-e', archiveFull, destFull] },
              'Cannot extract zip: install unzip or python3 on this node'
            );
          } else if (low.endsWith('.tar.gz') || low.endsWith('.tgz')) {
            output = runCmd('tar', ['-xzf', archiveFull, '-C', destFull]);
          } else if (low.endsWith('.tar.bz2') || low.endsWith('.tbz2')) {
            output = runCmd('tar', ['-xjf', archiveFull, '-C', destFull]);
          } else if (low.endsWith('.tar.xz') || low.endsWith('.txz')) {
            output = runCmd('tar', ['-xJf', archiveFull, '-C', destFull]);
          } else if (low.endsWith('.tar.zst')) {
            output = runCmd('tar', ['--zstd', '-xf', archiveFull, '-C', destFull]);
          } else if (low.endsWith('.tar')) {
            output = runCmd('tar', ['-xf', archiveFull, '-C', destFull]);
          } else if (low.endsWith('.gz')) {
            // single gzip — use built-in zlib, no system command needed
            const outFull = nodePath.join(destFull, nodePath.basename(archiveFull, '.gz'));
            const compressed = fs.readFileSync(archiveFull);
            fs.writeFileSync(outFull, zlib.gunzipSync(compressed));
            output = 'Extracted.';
          } else if (low.endsWith('.7z')) {
            output = runWithFallback(
              { cmd: '7z',  args: ['x', archiveFull, `-o${destFull}`, '-y'] },
              { cmd: '7za', args: ['x', archiveFull, `-o${destFull}`, '-y'] },
              'Cannot extract 7z: install p7zip-full on this node (apt install p7zip-full)'
            );
          } else {
            throw new Error('Unsupported archive format');
          }
          respond(requestId, { output: output || 'Extraction complete.' });
        } else {
          // Docker fallback — exec inside the running container
          if (!containerId) throw new Error('No container ID — server must be running to extract files without a data path');
          const sq = s => `'${String(s).replace(/'/g, "'\\''")}'`;
          const srcEsc = sq(archivePath);
          const dstContainerDir = destDir || nodePath.posix.dirname(archivePath);
          const dstEsc = sq(dstContainerDir);
          let shellCmd;
          if (low.endsWith('.zip'))                                  shellCmd = `unzip -o ${srcEsc} -d ${dstEsc} || python3 -m zipfile -e ${srcEsc} ${dstEsc}`;
          else if (low.endsWith('.tar.gz') || low.endsWith('.tgz')) shellCmd = `tar -xzf ${srcEsc} -C ${dstEsc}`;
          else if (low.endsWith('.tar.bz2') || low.endsWith('.tbz2')) shellCmd = `tar -xjf ${srcEsc} -C ${dstEsc}`;
          else if (low.endsWith('.tar.xz') || low.endsWith('.txz')) shellCmd = `tar -xJf ${srcEsc} -C ${dstEsc}`;
          else if (low.endsWith('.tar.zst'))                         shellCmd = `tar --zstd -xf ${srcEsc} -C ${dstEsc}`;
          else if (low.endsWith('.tar'))                             shellCmd = `tar -xf ${srcEsc} -C ${dstEsc}`;
          else if (low.endsWith('.gz'))                              shellCmd = `gunzip -kf ${srcEsc}`;
          else if (low.endsWith('.7z'))                              shellCmd = `7z x ${srcEsc} -o${dstEsc} -y || 7za x ${srcEsc} -o${dstEsc} -y`;
          else throw new Error('Unsupported archive format');
          const lines = [];
          await docker.execCommand(containerId, `mkdir -p ${dstEsc} && (${shellCmd}) 2>&1`, l => lines.push(l), 120000);
          respond(requestId, { output: lines.join('').trim() || 'Extraction complete.' });
        }
      } catch (err) {
        console.error(`[daemon] extract-archive error:`, err.message);
        respond(requestId, {}, err);
      }
      break;
    }

    case 'update-daemon': {
      const { requestId } = msg;
      const repoDir = nodePath.join(__dirname, '..');
      // Check this is actually a git repo before trying
      if (!fs.existsSync(nodePath.join(repoDir, '.git'))) {
        respond(requestId, {}, new Error(
          'Not a git repository. The daemon must be installed via git clone to use auto-update.\n' +
          'If running in Docker, rebuild the image instead: docker compose build daemon && docker compose up -d daemon'
        ));
        break;
      }
      const result = spawnSync('git', ['pull'], {
        cwd: repoDir,
        timeout: 60000,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.error) { respond(requestId, {}, result.error); break; }
      const output = (result.stdout + result.stderr).trim() || 'Already up to date.';
      if (result.status !== 0) { respond(requestId, {}, new Error(output)); break; }
      respond(requestId, { output });
      // Exit after response is sent — process manager (Docker restart policy, PM2 etc.) restarts with new code
      console.log('[daemon] Update pulled — restarting...');
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'git-remote-url': {
      const { requestId, serverId: ruServerId, path: ruPath } = msg;
      if (!dataPath || !ruServerId) { respond(requestId, {}, new Error('No data path configured on this node')); break; }
      try {
        const dataDir = serverDataDir(ruServerId);
        const hostTarget = toHostPath(ruPath || HOME_CONTAINER);
        const targetFull = nodePath.resolve(nodePath.join(dataDir, hostTarget.replace(/^\//, '')));
        if (!targetFull.startsWith(nodePath.resolve(dataDir) + nodePath.sep) && targetFull !== nodePath.resolve(dataDir)) {
          respond(requestId, {}, new Error('Path traversal detected'));
          break;
        }
        const result = spawnSync('git', ['-C', targetFull, 'remote', 'get-url', 'origin'], {
          timeout: 5000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        const url = (result.stdout || '').trim();
        respond(requestId, { url });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'git-pull': {
      const { requestId, serverId: pullServerId, path: pullTargetPath, strategy, authedUrl } = msg;
      if (!dataPath || !pullServerId) { respond(requestId, {}, new Error('No data path configured on this node')); break; }
      try {
        const dataDir = serverDataDir(pullServerId);
        const hostTarget = toHostPath(pullTargetPath || HOME_CONTAINER);
        const targetFull = nodePath.resolve(nodePath.join(dataDir, hostTarget.replace(/^\//, '')));
        if (!targetFull.startsWith(nodePath.resolve(dataDir) + nodePath.sep) && targetFull !== nodePath.resolve(dataDir)) {
          respond(requestId, {}, new Error('Path traversal detected'));
          break;
        }
        if (!fs.existsSync(nodePath.join(targetFull, '.git'))) {
          respond(requestId, {}, new Error('Not a git repository. Use Git Clone to clone a repo first.'));
          break;
        }
        const pullArgs = ['-C', targetFull, 'pull'];
        if (strategy === 'rebase') pullArgs.push('--rebase');
        else if (strategy === 'merge') { /* default git pull merge */ }
        else pullArgs.push('--ff-only');
        if (authedUrl) pullArgs.push(authedUrl);
        console.log(`[server:${pullServerId.slice(0,8)}] Git pull (${strategy || 'ff-only'}) in ${targetFull}`);
        const result = spawnSync('git', pullArgs, {
          timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
        });
        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          respond(requestId, {}, new Error((result.stderr || result.stdout || 'git pull failed').trim()));
          break;
        }
        const output = (result.stdout + result.stderr).trim() || 'Already up to date.';
        respond(requestId, { output });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'git-reset': {
      const { requestId, serverId: resetServerId, path: resetPath, commit, mode } = msg;
      if (!dataPath || !resetServerId) { respond(requestId, {}, new Error('No data path configured on this node')); break; }
      try {
        const dataDir = serverDataDir(resetServerId);
        const hostTarget = toHostPath(resetPath || HOME_CONTAINER);
        const targetFull = nodePath.resolve(nodePath.join(dataDir, hostTarget.replace(/^\//, '')));
        if (!targetFull.startsWith(nodePath.resolve(dataDir) + nodePath.sep) && targetFull !== nodePath.resolve(dataDir)) {
          respond(requestId, {}, new Error('Path traversal detected'));
          break;
        }
        if (!fs.existsSync(nodePath.join(targetFull, '.git'))) {
          respond(requestId, {}, new Error('Not a git repository.'));
          break;
        }
        const resetArgs = ['-C', targetFull, 'reset'];
        if (mode === 'soft') resetArgs.push('--soft');
        else if (mode === 'hard') resetArgs.push('--hard');
        else resetArgs.push('--mixed');
        resetArgs.push(commit || 'HEAD~1');
        console.log(`[server:${resetServerId.slice(0,8)}] Git reset --${mode || 'mixed'} ${commit || 'HEAD~1'} in ${targetFull}`);
        const result = spawnSync('git', resetArgs, {
          timeout: 30000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          respond(requestId, {}, new Error((result.stderr || result.stdout || 'git reset failed').trim()));
          break;
        }
        const output = (result.stdout + result.stderr).trim() || 'Reset complete.';
        respond(requestId, { output });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'write-files': {
      const { requestId, serverId, files } = msg;
      if (!Array.isArray(files) || files.length === 0) { respond(requestId, { written: 0 }); break; }
      if (!hasDataDir(serverId)) {
        respond(requestId, {}, new Error('No data directory — cannot write template files without dataPath configured'));
        break;
      }
      try {
        const dataDir = serverDataDir(serverId);
        for (const f of files) {
          hostfs.writeFile(dataDir, toHostPath(f.path), f.content || '');
        }
        respond(requestId, { written: files.length });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'export-server': {
      const { requestId, serverId: expServerId } = msg;
      if (!dataPath || !expServerId) {
        respond(requestId, { data: null, reason: 'no-datapath' });
        break;
      }
      const expDir = serverDataDir(expServerId);
      if (!fs.existsSync(expDir)) {
        respond(requestId, { data: null, reason: 'no-data-dir' });
        break;
      }
      try {
        console.log(`[server:${expServerId.slice(0,8)}] Exporting data dir for migration...`);
        const result = spawnSync('tar', ['-czf', '-', '-C', expDir, '.'], {
          maxBuffer: 2 * 1024 * 1024 * 1024,
          timeout: 300000,
        });
        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          respond(requestId, {}, new Error((result.stderr?.toString() || 'tar export failed').trim()));
          break;
        }
        console.log(`[server:${expServerId.slice(0,8)}] Export complete — ${result.stdout.length} bytes (compressed)`);
        respond(requestId, { data: result.stdout.toString('base64') });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'import-server': {
      const { requestId, serverId: impServerId, data } = msg;
      if (!dataPath || !impServerId) {
        respond(requestId, {}, new Error('No data path configured on this node'));
        break;
      }
      if (!data) {
        respond(requestId, {});
        break;
      }
      const impDir = serverDataDir(impServerId);
      fs.mkdirSync(impDir, { recursive: true });
      try {
        console.log(`[server:${impServerId.slice(0,8)}] Importing data dir from migration...`);
        const buf = Buffer.from(data, 'base64');
        const result = spawnSync('tar', ['-xzf', '-', '-C', impDir], {
          input: buf,
          maxBuffer: 2 * 1024 * 1024 * 1024,
          timeout: 300000,
        });
        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          respond(requestId, {}, new Error((result.stderr?.toString() || 'tar import failed').trim()));
          break;
        }
        console.log(`[server:${impServerId.slice(0,8)}] Import complete`);
        respond(requestId, {});
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }


    case 'ping': {
      respond(msg.requestId, { pong: true });
      break;
    }

    case 'node-stats': {
      const { requestId } = msg;
      try {
        const cpu = await getCpuPercent();
        const memTotal = os.totalmem();
        const memUsed  = memTotal - os.freemem();
        respond(requestId, { cpu, memUsed, memTotal });
      } catch (err) {
        respond(requestId, {}, err);
      }
      break;
    }

    case 'git-clone': {
      const { requestId, serverId, url, branch, folder, path: targetPath } = msg;
      if (!dataPath || !serverId) { respond(requestId, {}, new Error('No data path configured on this node')); break; }
      try {
        const dataDir = serverDataDir(serverId);
        const hostTarget = toHostPath(targetPath || HOME_CONTAINER);
        const base = nodePath.resolve(dataDir);

        // Derive folder name from URL if not provided
        const repoName = folder || url.split('/').pop().replace(/\.git$/, '') || 'repo';

        const targetFull = nodePath.resolve(nodePath.join(base, hostTarget.replace(/^\//, ''), repoName));
        if (!targetFull.startsWith(base + nodePath.sep) && targetFull !== base) {
          respond(requestId, {}, new Error('Path traversal detected'));
          break;
        }

        let result;
        const isGitRepo = fs.existsSync(nodePath.join(targetFull, '.git'));

        const safeUrl = url.replace(/\/\/[^@]*@/, '//');
        if (isGitRepo) {
          console.log(`[server:${serverId.slice(0,8)}] Git pull in ${targetFull}`);
          const pullArgs = ['-C', targetFull, 'pull', '--ff-only'];
          if (url !== safeUrl) pullArgs.push(url); // re-auth via URL for already-cloned private repos
          result = spawnSync('git', pullArgs, {
            timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
          });
        } else {
          console.log(`[server:${serverId.slice(0,8)}] Git clone ${safeUrl} → ${targetFull}`);
          const args = ['clone', '--depth', '1'];
          if (branch) args.push('--branch', branch);
          args.push(url, targetFull);
          result = spawnSync('git', args, {
            timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
          });
        }

        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          const msg = (result.stderr || result.stdout || 'git command failed').trim();
          respond(requestId, {}, new Error(msg));
          break;
        }

        // Strip embedded credentials from .git/config so they aren't readable via the file manager
        if (!isGitRepo && safeUrl !== url) {
          spawnSync('git', ['-C', targetFull, 'remote', 'set-url', 'origin', safeUrl], { timeout: 10000, encoding: 'utf8' });
        }

        const output = (result.stdout + result.stderr).trim() || (isGitRepo ? 'Already up to date.' : 'Clone complete.');
        respond(requestId, { output, pulled: isGitRepo, folder: repoName });
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
          // Ignore events for containers created by a different daemon on the same Docker host
          const evNodeId = ev.Actor?.Attributes?.['nodactyl.node-id'];
          if (ownNodeId && evNodeId && evNodeId !== ownNodeId) continue;
          if (ev.Action === 'start') {
            // Destroy any stale log stream from a previous container. Without this, the
            // subscribe-logs guard (activeLogStreams.has check) silently drops the new
            // subscription while the old stream (pointing to the removed container) still
            // holds the slot — causing "no such container" errors in the console.
            activeContainers.set(serverId, ev.id);
            const staleEntry = activeLogStreams.get(serverId);
            if (staleEntry) { try { staleEntry.stream.destroy(); } catch {} activeLogStreams.delete(serverId); }
            pendingLogSubs.delete(serverId);
            console.log(`[server:${serverId.slice(0, 8)}] Container started — notifying panel`);
            send({ type: 'server-status', serverId, status: 'running', containerId: ev.id });
          } else {
            const rawExit = ev.Actor?.Attributes?.exitCode ?? ev.Actor?.Attributes?.ExitCode;
            const exitCode = Number(rawExit);
            // 0=clean, 130=SIGINT, 137=SIGKILL (docker stop timeout), 143=SIGTERM (docker stop)
            const normalExits = new Set([0, 130, 137, 143]);
            const status = !isNaN(exitCode) && !normalExits.has(exitCode) ? 'error' : 'stopped';
            console.log(`[server:${serverId.slice(0, 8)}] Container exited (code ${rawExit ?? '?'}) — notifying panel (${status})`);
            send({ type: 'server-status', serverId, status });
            const dieEntry = activeLogStreams.get(serverId);
            if (dieEntry) { try { dieEntry.stream.destroy(); } catch {} activeLogStreams.delete(serverId); }
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
