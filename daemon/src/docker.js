const Docker = require('dockerode');
const tarStream = require('tar-stream');
const { posix: posixPath } = require('path');

const docker = new Docker(
  process.platform === 'win32'
    ? { socketPath: '//./pipe/docker_engine' }
    : { socketPath: '/var/run/docker.sock' }
);

async function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, out) => {
        if (err) reject(err); else resolve(out);
      });
    });
  });
}

async function createContainer({ serverId, image, portMappings = [], envVars = [], memoryLimit = 512, cpuLimit = 1.0, binds = [], startupCommand = '' }) {
  const ExposedPorts = {};
  const PortBindings = {};

  for (const pm of portMappings) {
    const proto = pm.protocol || 'tcp';
    const key = `${pm.containerPort}/${proto}`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostPort: String(pm.hostPort) }];
  }

  const memBytes = memoryLimit * 1024 * 1024;

  return docker.createContainer({
    name: `nodactyl-${serverId.slice(0, 8)}`,
    Image: image,
    ExposedPorts,
    Env: envVars.map(e => `${e.key}=${e.value}`),
    WorkingDir: '/home/container',
    ...(startupCommand ? { Cmd: ['/bin/sh', '-c', startupCommand] } : {}),
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
    StopSignal: 'SIGTERM',
    StopTimeout: 5,
    Labels: {
      'nodactyl.server-id': serverId,
      'nodactyl.managed': 'true',
      'nodactyl.startup-command': startupCommand || '',
    },
    HostConfig: {
      PortBindings,
      Binds: binds,
      Memory: memBytes,
      MemorySwap: memBytes * 2,        // allow swap equal to RAM
      MemorySwappiness: 10,            // prefer RAM, swap reluctantly
      NanoCpus: Math.floor(cpuLimit * 1e9),
      PidsLimit: 512,                  // prevent fork bombs
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'bridge',
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '25m', 'max-file': '3' },
      },
    },
  });
}

async function getStats(containerId) {
  const c = docker.getContainer(containerId);
  const stats = await new Promise((resolve, reject) =>
    c.stats({ stream: false }, (err, s) => err ? reject(err) : resolve(s))
  );

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
  const numCpu = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpu = cpuDelta > 0 && sysDelta > 0 ? ((cpuDelta / sysDelta) * numCpu * 100).toFixed(2) : '0.00';

  const cache = stats.memory_stats.stats?.cache ?? stats.memory_stats.stats?.inactive_file ?? 0;
  const memUsage = Math.max(0, (stats.memory_stats.usage || 0) - cache);
  const memLimit = stats.memory_stats.limit || 0;

  const network = stats.networks
    ? Object.values(stats.networks).reduce((a, n) => ({
        rx: a.rx + (n.rx_bytes || 0),
        tx: a.tx + (n.tx_bytes || 0),
      }), { rx: 0, tx: 0 })
    : { rx: 0, tx: 0 };

  return {
    cpu: parseFloat(cpu),
    memory: parseFloat((memUsage / 1024 / 1024).toFixed(1)),
    memoryLimit: parseFloat((memLimit / 1024 / 1024).toFixed(0)),
    pids: stats.pids_stats?.current ?? 0,
    network,
  };
}

async function streamLogs(containerId, onLine, tail = 100) {
  const c = docker.getContainer(containerId);

  // TTY containers emit raw bytes (no Docker multiplex header).
  // Non-TTY containers use the standard 8-byte frame format.
  let isTty = false;
  try { isTty = !!(await c.inspect()).Config.Tty; } catch {}

  const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail });

  stream.on('data', (chunk) => {
    if (isTty) {
      const text = chunk.toString('utf8');
      if (text) onLine(text);
      return;
    }
    let offset = 0;
    while (offset + 8 <= chunk.length) {
      const size = chunk.readUInt32BE(offset + 4);
      const end = offset + 8 + size;
      if (end > chunk.length) break;
      const text = chunk.slice(offset + 8, end).toString('utf8');
      if (text) onLine(text);
      offset = end;
    }
  });

  return stream;
}

async function execCommand(containerId, command, onLine, timeoutMs = 30000) {
  const c = docker.getContainer(containerId);
  const exec = await c.exec({
    Cmd: ['/bin/sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error('Command timed out after 30s'));
    }, timeoutMs);

    stream.on('data', chunk => {
      let offset = 0;
      while (offset + 8 <= chunk.length) {
        const size = chunk.readUInt32BE(offset + 4);
        const end = offset + 8 + size;
        if (end > chunk.length) break;
        const text = chunk.slice(offset + 8, end).toString('utf8');
        if (text) onLine(text);
        offset = end;
      }
    });

    stream.on('end', () => { clearTimeout(timer); resolve(); });
    stream.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function containerAction(containerId, action) {
  const c = docker.getContainer(containerId);
  try {
    switch (action) {
      case 'start':   return await c.start();
      case 'stop':    return await c.stop({ t: 5 });
      case 'restart': return await c.restart({ t: 5 });
      case 'kill':    return await c.kill({ Signal: 'SIGKILL' });
      case 'sigint':  return await c.kill({ Signal: 'SIGINT' });
      case 'sigterm': return await c.kill({ Signal: 'SIGTERM' });
      case 'remove':  return await c.remove({ force: true });
      default: throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    // Treat "already in desired state" as success
    const msg = err.message || '';
    const notFound = /No such container/i.test(msg);
    const alreadyStopped = /not running|already stopped/i.test(msg) || notFound;
    const alreadyStarted = /already started/i.test(msg);
    if ((action === 'stop' || action === 'kill' || action === 'sigint' || action === 'sigterm') && alreadyStopped) return;
    if (action === 'start' && alreadyStarted) return;
    if (action === 'remove' && notFound) return;
    throw err;
  }
}

async function getContainerInfo(containerId) {
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    image: info.Config.Image,
    status: info.State.Status,
    running: info.State.Running,
    paused: info.State.Paused,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
    exitCode: info.State.ExitCode,
    ports: info.NetworkSettings.Ports,
    labels: info.Config.Labels || {},
    memory: info.HostConfig.Memory,
    nanoCpus: info.HostConfig.NanoCpus,
    pidsLimit: info.HostConfig.PidsLimit,
  };
}

function toContainerPath(input) {
  const raw = String(input || '/').replace(/\\/g, '/').trim();
  if (!raw || raw === '.') return '/';
  return posixPath.normalize(raw.startsWith('/') ? raw : `/${raw}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function decodeDockerPayload(chunk) {
  const frames = [];
  let offset = 0;

  while (offset + 8 <= chunk.length) {
    const size = chunk.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > chunk.length) break;
    frames.push(chunk.subarray(start, end));
    offset = end;
  }

  return frames.length ? Buffer.concat(frames) : chunk;
}

function normalizeArchiveName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function archiveRelativeName(name, baseName) {
  if (!name || name === '.') return '';
  if (!baseName) return name;
  if (name === baseName) return '';
  if (name.startsWith(`${baseName}/`)) return name.slice(baseName.length + 1);
  return name;
}

function fileSort(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function listFiles(containerId, dirPath) {
  const targetPath = toContainerPath(dirPath);
  const c = docker.getContainer(containerId);

  // Fast path: exec-based listing when the container is running.
  try {
    const info = await c.inspect();
    if (info.State.Running) {
      const exec = await c.exec({
        Cmd: ['sh', '-c', `ls -1ap ${shellQuote(targetPath)} 2>&1`],
        AttachStdout: true, AttachStderr: true,
      });
      const stream = await exec.start();
      const chunks = [];
      stream.on('data', chunk => chunks.push(decodeDockerPayload(chunk)));
      const output = await new Promise((resolve, reject) => {
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      });
      if (!output.startsWith('ls:') && !output.includes('No such file')) {
        return output.split('\n')
          .filter(n => n && n !== './' && n !== '../')
          .map(n => ({
            name: n.endsWith('/') ? n.slice(0, -1) : n,
            type: n.endsWith('/') ? 'dir' : 'file',
            size: null,
            mtime: null,
          }))
          .sort(fileSort);
      }
    }
  } catch { /* stopped or exec unavailable, fall through to archive method */ }

  // Docker archives work even when the container process is stopped.
  const archiveStream = await c.getArchive({ path: targetPath });
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    const entries = new Map();
    const baseName = targetPath === '/' ? '' : posixPath.basename(targetPath);
    let settled = false;

    function fail(err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }

    extract.on('entry', (header, stream, next) => {
      try {
        const name = normalizeArchiveName(header.name);
        const relative = archiveRelativeName(name, baseName);
        const parts = relative.split('/').filter(Boolean);
        const child = parts[0];

        if (child) {
          const isDir = header.type === 'directory' || parts.length > 1;
          const existing = entries.get(child);
          entries.set(child, {
            name: child,
            type: isDir || existing?.type === 'dir' ? 'dir' : 'file',
            size: isDir ? null : (header.size ?? null),
            mtime: header.mtime ? header.mtime.toISOString() : null,
          });
        }
      } catch (err) {
        fail(err);
      }

      stream.resume();
      stream.on('end', next);
    });

    extract.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve([...entries.values()].sort(fileSort));
      }
    });
    extract.on('error', fail);
    archiveStream.on('error', fail);
    archiveStream.pipe(extract);
  });
}

async function readFile(containerId, filePath) {
  const targetPath = toContainerPath(filePath);
  const c = docker.getContainer(containerId);
  const archiveStream = await c.getArchive({ path: targetPath });
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    const chunks = [];
    let foundFile = false;
    let foundDirectory = false;
    let settled = false;

    function fail(err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }

    extract.on('entry', (header, stream, next) => {
      if (header.type === 'directory') {
        foundDirectory = true;
      } else if (!foundFile) {
        foundFile = true;
        stream.on('data', chunk => chunks.push(chunk));
      }
      stream.on('end', next);
      stream.resume();
    });
    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      if (foundDirectory && !foundFile) return reject(new Error('Cannot read a directory'));
      if (!foundFile) return reject(new Error('File not found'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    extract.on('error', fail);
    archiveStream.on('error', fail);
    archiveStream.pipe(extract);
  });
}

async function writeFile(containerId, filePath, content, encoding = 'utf8') {
  const targetPath = toContainerPath(filePath);
  if (targetPath === '/') throw new Error('Cannot write to root directory');

  const c = docker.getContainer(containerId);
  const fileName = posixPath.basename(targetPath);
  const dirPath = posixPath.dirname(targetPath) || '/';
  const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');

  const tarBuffer = await new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    const out = [];
    pack.on('data', chunk => out.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(out)));
    pack.on('error', reject);
    pack.entry({ name: fileName, size: buf.length, mode: 0o644 }, buf, (err) => {
      if (err) return reject(err);
      pack.finalize();
    });
  });

  await c.putArchive(tarBuffer, { path: dirPath });
}

async function createDirectory(containerId, dirPath) {
  const targetPath = toContainerPath(dirPath);
  if (targetPath === '/') throw new Error('Cannot create root directory');

  const c = docker.getContainer(containerId);
  const dirName = posixPath.basename(targetPath);
  const parentDir = posixPath.dirname(targetPath) || '/';

  let running = false;
  try { running = (await c.inspect()).State.Running; } catch {}

  if (running) {
    const exec = await c.exec({
      Cmd: ['sh', '-c', `mkdir -p ${shellQuote(targetPath)} 2>&1`],
      AttachStdout: true, AttachStderr: true,
    });
    const stream = await exec.start();
    const parts = [];
    stream.on('data', chunk => parts.push(decodeDockerPayload(chunk)));
    const out = await new Promise((resolve, reject) => {
      stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      stream.on('error', reject);
    });
    if (out.trim()) throw new Error(out.trim());
    return;
  }

  // Stopped container — create via putArchive with a placeholder file
  const tarBuffer = await new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    const parts = [];
    pack.on('data', c => parts.push(c));
    pack.on('end', () => resolve(Buffer.concat(parts)));
    pack.on('error', reject);
    pack.entry({ name: dirName + '/.keep', size: 0, mode: 0o644 }, Buffer.alloc(0), (err) => {
      if (err) return reject(err);
      pack.finalize();
    });
  });

  await c.putArchive(tarBuffer, { path: parentDir });
}

async function deleteFile(containerId, filePath) {
  const targetPath = toContainerPath(filePath);
  if (targetPath === '/') throw new Error('Cannot delete root');

  const c = docker.getContainer(containerId);
  let running = false;
  try { running = (await c.inspect()).State.Running; } catch {}
  if (!running) throw new Error('Container must be running to delete files');

  const exec = await c.exec({
    Cmd: ['sh', '-c', `rm -rf ${shellQuote(targetPath)} 2>&1`],
    AttachStdout: true, AttachStderr: true,
  });
  const stream = await exec.start();
  const parts = [];
  stream.on('data', chunk => parts.push(decodeDockerPayload(chunk)));
  const out = await new Promise((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', reject);
  });
  if (out.trim()) throw new Error(out.trim());
}

async function renameFile(containerId, oldPath, newPath) {
  const srcPath = toContainerPath(oldPath);
  const dstPath = toContainerPath(newPath);

  const c = docker.getContainer(containerId);
  let running = false;
  try { running = (await c.inspect()).State.Running; } catch {}
  if (!running) throw new Error('Container must be running to rename files');

  const exec = await c.exec({
    Cmd: ['sh', '-c', `mv ${shellQuote(srcPath)} ${shellQuote(dstPath)} 2>&1`],
    AttachStdout: true, AttachStderr: true,
  });
  const stream = await exec.start();
  const parts = [];
  stream.on('data', chunk => parts.push(decodeDockerPayload(chunk)));
  const out = await new Promise((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    stream.on('error', reject);
  });
  if (out.trim()) throw new Error(out.trim());
}

module.exports = { docker, pullImage, createContainer, getStats, getContainerInfo, streamLogs, execCommand, containerAction, listFiles, readFile, writeFile, createDirectory, deleteFile, renameFile };
