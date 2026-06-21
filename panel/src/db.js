const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'data', 'panel.db');

let _db = null;
let _saveTimer = null;

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  }, 300);
}

function prepare(sql) {
  return {
    get(...args) {
      const params = args.flat();
      const stmt = _db.prepare(sql);
      stmt.bind(params.length ? params : []);
      if (!stmt.step()) { stmt.free(); return undefined; }
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    all(...args) {
      const params = args.flat();
      const stmt = _db.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    run(...args) {
      const params = args.flat();
      _db.run(sql, params.length ? params : []);
      const changes = _db.getRowsModified();
      scheduleSave();
      return { changes };
    },
  };
}

function exec(sql) {
  _db.exec(sql);
  scheduleSave();
}

const db = new Proxy({}, {
  get(_, prop) {
    if (prop === 'prepare') return prepare;
    if (prop === 'exec') return exec;
    if (prop === '_raw') return _db;
    throw new Error(`db.${prop} not implemented`);
  },
});

async function init() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS ranks (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#6366f1',
      max_servers INTEGER DEFAULT 1,
      memory_limit INTEGER DEFAULT 0,
      disk_limit INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      suspended INTEGER DEFAULT 0,
      rank_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      memory INTEGER DEFAULT 4096,
      cpu INTEGER DEFAULT 4,
      status TEXT DEFAULT 'offline',
      last_seen INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      image TEXT NOT NULL,
      container_id TEXT,
      node_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      port_mappings TEXT DEFAULT '[]',
      env_vars TEXT DEFAULT '[]',
      memory_limit INTEGER DEFAULT 512,
      cpu_limit REAL DEFAULT 1.0,
      status TEXT DEFAULT 'installing',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      image TEXT NOT NULL,
      port_mappings TEXT DEFAULT '[]',
      env_vars TEXT DEFAULT '[]',
      memory_limit INTEGER DEFAULT 512,
      cpu_limit REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Migrations for existing databases
  try { _db.exec(`ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN rank_id TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN startup_command TEXT DEFAULT ''`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN home_dir TEXT DEFAULT '/home/container'`); } catch {}
  try { _db.exec(`ALTER TABLE presets ADD COLUMN startup_command TEXT DEFAULT ''`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN disk_limit INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN discord_webhook TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE nodes ADD COLUMN disk_limit INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE nodes ADD COLUMN port_range_start INTEGER DEFAULT 10000`); } catch {}
  try { _db.exec(`ALTER TABLE nodes ADD COLUMN port_range_end INTEGER DEFAULT 30000`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN suspended INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN started_at INTEGER DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE presets ADD COLUMN install_script TEXT DEFAULT ''`); } catch {}
  try { _db.exec(`ALTER TABLE presets ADD COLUMN required_rank_id TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN install_script TEXT DEFAULT ''`); } catch {}
  try { _db.exec(`ALTER TABLE ranks ADD COLUMN memory_limit INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE ranks ADD COLUMN disk_limit INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN discord_config TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE presets ADD COLUMN disk_limit INTEGER DEFAULT 0`); } catch {}
  try { _db.exec(`ALTER TABLE servers ADD COLUMN terminal_mode INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { _db.exec(`CREATE TABLE IF NOT EXISTS server_members (server_id TEXT NOT NULL, user_id INTEGER NOT NULL, permissions TEXT NOT NULL DEFAULT '["console"]', created_at INTEGER DEFAULT (strftime('%s','now')), PRIMARY KEY (server_id, user_id))`); } catch {}
  try { _db.exec(`CREATE TABLE IF NOT EXISTS log_shares (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, label TEXT, content TEXT NOT NULL, view_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER DEFAULT (strftime('%s','now')), expires_at INTEGER NOT NULL)`); } catch {}
  try { _db.exec(`ALTER TABLE log_shares ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { _db.exec(`CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', image TEXT NOT NULL, env_vars TEXT DEFAULT '[]', memory_limit INTEGER DEFAULT 512, cpu_limit REAL DEFAULT 1.0, disk_limit INTEGER DEFAULT 0, startup_command TEXT DEFAULT '', install_script TEXT DEFAULT '', required_rank_id TEXT DEFAULT NULL, files TEXT DEFAULT '[]', created_at INTEGER DEFAULT (strftime('%s','now')))`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN discord_id TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN discord_username TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN github_id TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE users ADD COLUMN github_username TEXT DEFAULT NULL`); } catch {}
  try { _db.exec(`ALTER TABLE presets ADD COLUMN images TEXT DEFAULT '[]'`); } catch {}
  try { _db.exec(`ALTER TABLE nodes ADD COLUMN ip_address TEXT DEFAULT ''`); } catch {}

  // Seed default ranks
  const rankCount = prepare('SELECT COUNT(*) as count FROM ranks').get();
  if (!rankCount || rankCount.count === 0) {
    const defaultRanks = [
      { name: 'Basic',    color: '#64748b', max_servers: 1,  memory_limit: 512,  disk_limit: 5120,  sort_order: 0 },
      { name: 'Standard', color: '#3b82f6', max_servers: 3,  memory_limit: 1024, disk_limit: 10240, sort_order: 1 },
      { name: 'Premium',  color: '#6366f1', max_servers: 10, memory_limit: 2048, disk_limit: 20480, sort_order: 2 },
      { name: 'VIP',      color: '#f59e0b', max_servers: -1, memory_limit: 4096, disk_limit: 0,     sort_order: 3 },
    ];
    for (const r of defaultRanks) {
      prepare('INSERT INTO ranks (id, name, color, max_servers, memory_limit, disk_limit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), r.name, r.color, r.max_servers, r.memory_limit, r.disk_limit, r.sort_order);
    }
    console.log('  Seeded default ranks: Basic, Standard, Premium, VIP');
  }

  // Seed default settings
  const defaultSettings = {
    panel_name: 'Nodactyl',
    panel_logo: 'N',
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (!existing) prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  // Seed default admin
  const row = prepare('SELECT COUNT(*) as count FROM users').get();
  if (!row || row.count === 0) {
    const hashed = bcrypt.hashSync('admin', 10);
    prepare('INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), 'admin', 'admin@nodactyl.local', hashed, 'admin');
    console.log('  Default admin — username: admin  password: admin');
  }

  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

module.exports = { db, init };
