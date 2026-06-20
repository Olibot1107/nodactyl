const WebSocket = require('ws');
const nodePath = require('path');
const fs = require('fs');
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
      if (msg.success) console.log(`[daemon] Authenticated as node "${msg.name}"`);
      else { console.error('[daemon] Auth failed:', msg.error); process.exit(1); }
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
          serverId, image, portMappings,
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
        npm:      isManifest ? 'npm install'                     : `npm install ${pkg}`,
        yarn:     isManifest ? 'yarn install'                    : `yarn add ${pkg}`,
        pip:      isManifest ? 'pip install --target /home/container/packages -r requirements.txt'  : `pip install --target /home/container/packages ${pkg}`,
        pip3:     isManifest ? 'pip3 install --target /home/container/packages -r requirements.txt' : `pip3 install --target /home/container/packages ${pkg}`,
        composer: isManifest ? 'composer install'                : `composer require ${pkg}`,
        gem:      isManifest ? null                              : `gem install ${pkg}`,
        cargo:    isManifest ? 'cargo build'                     : `cargo add ${pkg}`,
      };
      if (!CMDS[manager]) {
        respond(requestId, {}, new Error(isManifest ? `${manager} does not support manifest installs` : `Unknown package manager: ${manager}`));
        break;
      }
      let pkgContainer = null;
      try {
        const binds = dataPath && serverId ? [`${nodePath.join(hostDataPath, serverId)}:/home/container`] : [];
        const memBytes = (memoryLimit || 512) * 1024 * 1024;

        send({ type: 'log', serverId, line: `\r\n\x1b[33m[Nodactyl] Running: ${CMDS[manager]}\x1b[0m\r\n` });

        pkgContainer = await docker.docker.createContainer({
          Image: image,
          Cmd: ['/bin/sh', '-c', CMDS[manager]],
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

    case 'git-pull': {
      const { requestId, serverId: pullServerId, path: pullTargetPath, strategy } = msg;
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
        console.log(`[server:${pullServerId.slice(0,8)}] Git pull (${strategy || 'ff-only'}) in ${targetFull}`);
        const result = spawnSync('git', pullArgs, {
          timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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

        if (isGitRepo) {
          console.log(`[server:${serverId.slice(0,8)}] Git pull in ${targetFull}`);
          result = spawnSync('git', ['-C', targetFull, 'pull', '--ff-only'], {
            timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          });
        } else {
          console.log(`[server:${serverId.slice(0,8)}] Git clone ${url} → ${targetFull}`);
          const args = ['clone', '--depth', '1'];
          if (branch) args.push('--branch', branch);
          args.push(url, targetFull);
          result = spawnSync('git', args, {
            timeout: 270000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          });
        }

        if (result.error) { respond(requestId, {}, result.error); break; }
        if (result.status !== 0) {
          const msg = (result.stderr || result.stdout || 'git command failed').trim();
          respond(requestId, {}, new Error(msg));
          break;
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
            const exitCode = ev.Actor?.Attributes?.exitCode ?? ev.Actor?.Attributes?.ExitCode;
            console.log(`[server:${serverId.slice(0, 8)}] Container exited (code ${exitCode ?? '?'}) — notifying panel`);
            send({ type: 'server-status', serverId, status: 'stopped' });
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
