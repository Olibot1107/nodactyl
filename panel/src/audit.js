const { db } = require('./db');

function resolveIp(ipOrReq) {
  if (!ipOrReq) return null;
  if (typeof ipOrReq === 'string') return ipOrReq;
  // Request object — prefer Cloudflare header, then common proxy headers, then Express req.ip
  const h = ipOrReq.headers || {};
  return h['cf-connecting-ip']
    || h['x-real-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || ipOrReq.ip
    || null;
}

function audit(userId, serverId, action, metadata = {}, ipOrReq = null) {
  if (!userId) return;
  const ip = resolveIp(ipOrReq) || null;
  try {
    db.prepare('INSERT INTO audit_logs (user_id, server_id, action, metadata, ip) VALUES (?, ?, ?, ?, ?)')
      .run(userId, serverId || null, action, JSON.stringify(metadata), ip);
  } catch {}
}

module.exports = { audit };
