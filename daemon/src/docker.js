const Docker = require('dockerode');

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

async function createContainer({ serverId, image, portMappings = [], envVars = [], memoryLimit = 512, cpuLimit = 1.0 }) {
  const ExposedPorts = {};
  const PortBindings = {};

  for (const pm of portMappings) {
    const proto = pm.protocol || 'tcp';
    const key = `${pm.containerPort}/${proto}`;
    ExposedPorts[key] = {};
    PortBindings[key] = [{ HostPort: String(pm.hostPort) }];
  }

  return docker.createContainer({
    name: `nodactyl-${serverId.slice(0, 8)}`,
    Image: image,
    ExposedPorts,
    Env: envVars.map(e => `${e.key}=${e.value}`),
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
    HostConfig: {
      PortBindings,
      Memory: memoryLimit * 1024 * 1024,
      NanoCpus: Math.floor(cpuLimit * 1e9),
    },
  });
}

async function getStats(containerId) {
  const c = docker.getContainer(containerId);
  const stats = await new Promise((resolve, reject) =>
    c.stats({ stream: false }, (err, s) => err ? reject(err) : resolve(s))
  );

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const numCpu = stats.cpu_stats.online_cpus || 1;
  const cpu = sysDelta > 0 ? ((cpuDelta / sysDelta) * numCpu * 100).toFixed(2) : '0.00';

  const memUsage = (stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0));
  const memLimit = stats.memory_stats.limit;

  return {
    cpu: parseFloat(cpu),
    memory: parseFloat((memUsage / 1024 / 1024).toFixed(1)),
    memoryLimit: parseFloat((memLimit / 1024 / 1024).toFixed(0)),
    network: stats.networks
      ? Object.values(stats.networks).reduce((a, n) => ({
          rx: a.rx + n.rx_bytes,
          tx: a.tx + n.tx_bytes,
        }), { rx: 0, tx: 0 })
      : { rx: 0, tx: 0 },
  };
}

async function streamLogs(containerId, onLine) {
  const c = docker.getContainer(containerId);
  const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 100 });

  stream.on('data', (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (offset + 8 > chunk.length) break;
      const size = chunk.readUInt32BE(offset + 4);
      const payload = chunk.slice(offset + 8, offset + 8 + size).toString('utf8');
      onLine(payload);
      offset += 8 + size;
    }
  });

  return stream;
}

async function execCommand(containerId, command) {
  const c = docker.getContainer(containerId);
  const exec = await c.exec({ Cmd: ['/bin/sh', '-c', command], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start();
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk.slice(8)));
  return new Promise(resolve => stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))));
}

async function containerAction(containerId, action) {
  const c = docker.getContainer(containerId);
  switch (action) {
    case 'start':   return c.start();
    case 'stop':    return c.stop();
    case 'restart': return c.restart();
    case 'kill':    return c.kill();
    case 'remove':  return c.remove({ force: true });
  }
}

module.exports = { docker, pullImage, createContainer, getStats, streamLogs, execCommand, containerAction };
