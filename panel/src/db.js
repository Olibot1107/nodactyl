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

// Thin better-sqlite3-compatible wrapper around sql.js
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

// Export a proxy so callers can do db.prepare(...) / db.exec(...)
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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
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
  `);

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
