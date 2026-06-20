const fs = require('fs');
const nodePath = require('path');

function safePath(dataDir, userPath) {
  const clean = nodePath.normalize(String(userPath || '/').replace(/\\/g, '/'));
  const full = nodePath.resolve(dataDir, clean.replace(/^\/+/, ''));
  const base = nodePath.resolve(dataDir);
  if (!full.startsWith(base + nodePath.sep) && full !== base) {
    throw new Error('Path traversal detected');
  }
  return full;
}

function fileSort(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function listFiles(dataDir, dirPath) {
  const fullPath = safePath(dataDir, dirPath);
  if (!fs.existsSync(fullPath)) throw new Error(`Path not found: ${dirPath}`);
  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) throw new Error('Not a directory');

  return fs.readdirSync(fullPath, { withFileTypes: true }).map(e => {
    try {
      const s = fs.statSync(nodePath.join(fullPath, e.name));
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? s.size : null,
        mtime: s.mtime.toISOString(),
      };
    } catch {
      return { name: e.name, type: 'file', size: null, mtime: null };
    }
  }).sort(fileSort);
}

function readFile(dataDir, filePath) {
  const fullPath = safePath(dataDir, filePath);
  if (!fs.existsSync(fullPath)) throw new Error('File not found');
  if (fs.statSync(fullPath).isDirectory()) throw new Error('Cannot read a directory');
  return fs.readFileSync(fullPath, 'utf8');
}

function writeFile(dataDir, filePath, content, encoding = 'utf8') {
  const fullPath = safePath(dataDir, filePath);
  fs.mkdirSync(nodePath.dirname(fullPath), { recursive: true });
  const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  fs.writeFileSync(fullPath, buf);
}

function createDirectory(dataDir, dirPath) {
  const fullPath = safePath(dataDir, dirPath);
  fs.mkdirSync(fullPath, { recursive: true });
}

function deleteFile(dataDir, filePath) {
  const fullPath = safePath(dataDir, filePath);
  if (!fs.existsSync(fullPath)) throw new Error('File not found');
  fs.rmSync(fullPath, { recursive: true, force: true });
}

function renameFile(dataDir, oldPath, newPath) {
  const oldFull = safePath(dataDir, oldPath);
  const newFull = safePath(dataDir, newPath);
  if (!fs.existsSync(oldFull)) throw new Error('File not found');
  fs.mkdirSync(nodePath.dirname(newFull), { recursive: true });
  fs.renameSync(oldFull, newFull);
}

function getDiskUsage(dir) {
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) bytes += getDiskUsage(full);
      else { try { bytes += fs.statSync(full).size; } catch {} }
    }
  } catch {}
  return bytes;
}

module.exports = { listFiles, readFile, writeFile, createDirectory, deleteFile, renameFile, getDiskUsage };
