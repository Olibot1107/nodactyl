const { db } = require('./db');
const nodeManager = require('./nodeManager');
const log = require('./log');

function runCleanup() {
  // Servers marked deleting with a known container — send delete to daemon
  const stale = db.prepare("SELECT * FROM servers WHERE status = 'deleting' AND container_id IS NOT NULL").all();
  for (const server of stale) {
    if (nodeManager.isOnline(server.node_id)) {
      log.info('cleanup', `Removing orphaned container for "${server.name}" (${server.id.slice(0, 8)})`);
      nodeManager.send(server.node_id, { type: 'delete-server', serverId: server.id, containerId: server.container_id })
        .catch(() => {})
        .finally(() => {
          db.prepare("DELETE FROM servers WHERE id = ? AND status = 'deleting'").run(server.id);
        });
    } else {
      log.warn('cleanup', `Node offline — removing "${server.name}" (${server.id.slice(0, 8)}) from DB; container may be orphaned`);
      db.prepare("DELETE FROM servers WHERE id = ? AND status = 'deleting'").run(server.id);
    }
  }
}

function startCleanupJobs() {
  const interval = setInterval(runCleanup, 8000);
  interval.unref();
}

module.exports = { startCleanupJobs };
