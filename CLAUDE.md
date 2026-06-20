# Nodactyl — Claude Code Context

Custom game server hosting panel. Two separate Node.js apps: **panel** (web UI + REST API) and **daemon** (runs on each node, manages Docker containers).

## Architecture

```
panel/          — Express web server + SQLite DB + Socket.IO
  src/
    index.js          — app entry, WebSocket daemon endpoint, Socket.IO auth/rooms
    db.js             — sql.js (WASM SQLite) wrapper; uses a Proxy so db is always importable
    nodeManager.js    — manages daemon WebSocket connections, routes log/status events
    middleware/
      auth.js         — JWT verify + DB re-check on every request; crashes if JWT_SECRET unset
    routes/
      auth.js         — login, register, /me; rate-limited
      servers.js      — CRUD + file manager + suspend/unsuspend + git-clone
      presets.js      — server templates (admin creates, users deploy); rank-gated
      nodes.js        — node CRUD + daemon update/token-reset
      users.js        — admin: list/suspend/unsuspend/role/rank/delete
      ranks.js        — rank CRUD (sort_order, max_servers, memory_limit, disk_limit)
      settings.js     — key-value panel settings (panel_name, panel_logo, etc.)
  public/
    dashboard.html    — server list + preset deploy
    server.html       — console, stats, uptime, actions
    server-settings.html — name/startup/env-vars/discord webhook
    files.html        — file manager
    nodes.html        — admin: node management
    admin/
      servers.html    — admin: all servers (stop/start/suspend/delete)
      presets.html    — admin: preset management
      users.html      — admin: user management
      ranks.html      — admin: rank management
      settings.html   — admin: panel settings

daemon/
  src/
    index.js    — WebSocket client; handles install-server, server-action, file ops, git-clone
    docker.js   — dockerode wrapper (create/start/stop/exec/logs/file ops via tar archive)
    hostfs.js   — direct host filesystem ops (used when dataPath is configured); path traversal protected
  config.json   — { panelUrl, token, dataPath, hostDataPath } (gitignored)
```

## Database (sql.js / WASM SQLite)

`db` is a **Proxy** — safe to import at module load time before `init()`. `_db` is set during `await init()` in `main()`. Tables:

- `users` — id, username, email, password (bcrypt), role (user|admin), rank_id, suspended, avatar
- `servers` — id, name, image, node_id, owner_id, status, container_id, port_mappings (JSON), env_vars (JSON), memory_limit, cpu_limit, disk_limit, startup_command, install_script, suspended, started_at
- `nodes` — id, name, token, memory, cpu, disk_limit, port_range_start, port_range_end, status
- `presets` — id, name, image, env_vars (JSON), memory_limit, cpu_limit, disk_limit, startup_command, install_script, required_rank_id
- `ranks` — id, name, color, max_servers (-1 = unlimited), memory_limit, disk_limit, sort_order
- `settings` — key, value (key-value store; keys must match `[a-z][a-z0-9_]*`)

Schema migrations are `try/catch ALTER TABLE` blocks at the bottom of `db.js init()`.

## Key Behaviours

### Auth
- JWT signed with `JWT_SECRET` env var (24h expiry). **Panel crashes on startup if not set.**
- `requireAuth` re-reads user from DB every request — suspensions and role changes take effect immediately.
- Cookie: `httpOnly: true`, `sameSite: strict`.
- Rate limiting: login 10/15min, register 5/hr (express-rate-limit).
- Registration gated by `REGISTRATION_OPEN=true` env var.

### Ports
- Each node has `port_range_start` / `port_range_end`. No user choice.
- `autoPortMappings(nodeId)` picks the first free port in the node's range (scoped to that node's servers).
- Every server gets one port exposed as both TCP and UDP; `hostPort === containerPort`.

### Server Suspension
- `suspended = 1` on server row blocks: start action, file access, settings PATCH, DELETE — for non-admins.
- Admin can suspend/unsuspend via `POST /:id/suspend` and `POST /:id/unsuspend`.
- Suspending also stops the container if it's running.

### Install Scripts
- Stored on preset and copied to server at create time.
- Run in a **temporary Docker container** (same image + bind mount, no port bindings) before the real container is created.
- Output streamed as log lines to panel while installing; server stays in `installing` status.
- If exit code ≠ 0, server goes to `error` status.
- While `status = 'installing'`, all actions are blocked.

### Presets / Rank Gates
- `required_rank_id` on preset: users need `rank.sort_order >= required_rank.sort_order` to see or deploy.
- Both `GET /api/presets/` and `GET /api/presets/:id` enforce this.
- Dashboard hides Deploy buttons and shows a warning when user is at `rank.max_servers` limit.
- Admin always bypasses all rank/preset checks.

### Socket.IO Rooms
- On connect: user joins `user:{userId}` room; admins also join `admins` room.
- `server-status` and `stats` events are emitted to `user:{ownerId}` + `admins` — NOT broadcast to all.
- `node-status` is still broadcast to all (low sensitivity).

### Daemon Communication
- Daemon authenticates over WebSocket with a node token (`SELECT * FROM nodes WHERE token = ?`).
- Panel → daemon: JSON messages with `requestId`; daemon replies with `{ type:'response', requestId, success, data, error }`.
- `server-status` updates from daemon are validated: serverId must belong to the sending node.
- File ops use `hostfs.js` (direct FS) when `dataPath` is configured, otherwise Docker tar archive API.

### File Manager Path Safety
- Panel passes raw path strings to daemon.
- Daemon: `toHostPath()` strips `/home/container` prefix.
- `hostfs.safePath()` resolves against `dataDir` and rejects anything that escapes it.
- Git clone: URL must be `https://`, non-private (blocks `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `169.254.*`).

## Environment Variables

| Var | Required | Description |
|-----|----------|-------------|
| `JWT_SECRET` | **YES** (crashes if missing) | Random secret for JWT signing. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `REGISTRATION_OPEN` | No (default: closed) | Set to `true` to allow public registration |
| `PORT` | No (default: 3000) | Panel HTTP port |

Daemon config is in `daemon/config.json` (gitignored — copy `config.example.json`):
```json
{ "panelUrl": "http://panel:3000", "token": "<node-token-from-panel>", "dataPath": "/srv/nodactyl", "hostDataPath": "/srv/nodactyl" }
```

## Running

```bash
# Panel
cd panel && npm install
JWT_SECRET=... REGISTRATION_OPEN=true node src/index.js

# Daemon
cd daemon && npm install
node src/index.js

# Docker Compose (both)
JWT_SECRET=... docker compose up
```

## Common Pitfalls

- `db` Proxy: importing `db` before `await init()` is safe. The Proxy delegates at call time, not import time.
- sql.js is WASM and needs async init — that's why `db.js` exports `{ db, init }` and `index.js` calls `await init()` first.
- Container names are `nodactyl-{serverId.slice(0,8)}` — not the server's display name.
- Startup command changes trigger container recreation on next start (daemon detects via `nodactyl.startup-command` label).
- `hostDataPath` vs `dataPath`: when daemon runs in Docker, the bind mount must use the **host** path, not the path inside the daemon container.
- TTY containers (`Tty: true`) emit raw bytes; non-TTY use Docker multiplex framing. `streamLogs` in `docker.js` handles both.
- The `stats` push case in `nodeManager._handleMessage` exists for future daemon-push stats but daemon currently doesn't push stats proactively (panel polls via `GET /api/servers/:id/stats`).

## Security Notes (things already fixed, don't revert)

- `JWT_SECRET` must come from env — no fallback default.
- Cookie is `httpOnly: true` — JS cannot read it.
- `requireAuth` re-checks DB — don't cache role/suspension in JWT alone.
- `server-status` from daemon is node-scoped — validate before updating DB.
- Socket.IO events are room-scoped — don't use `io.emit()` for per-server events.
- Settings keys must match `[a-z][a-z0-9_]*` — don't relax this.
- Git clone blocks private IPs — don't allow `file://` or `http://` schemes either.
