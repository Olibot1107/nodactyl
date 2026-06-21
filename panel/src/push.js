const webpush = require('web-push');
const { v4: uuidv4 } = require('uuid');

let _keys = null;

function initVapid() {
  const { db } = require('./db');
  const pub  = db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()?.value;
  const priv = db.prepare("SELECT value FROM settings WHERE key = 'vapid_private_key'").get()?.value;

  if (pub && priv) {
    _keys = { publicKey: pub, privateKey: priv };
  } else {
    _keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vapid_public_key', ?)").run(_keys.publicKey);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vapid_private_key', ?)").run(_keys.privateKey);
    console.log('  [push] Generated VAPID keys');
  }
  webpush.setVapidDetails('mailto:noreply@nodactyl.local', _keys.publicKey, _keys.privateKey);
}

function getPublicKey() {
  return _keys?.publicKey || null;
}

async function sendStatusPush(userId, serverName, serverId, status) {
  if (!_keys) return;
  const NOTIFY = new Set(['error']);
  if (!NOTIFY.has(status)) return;

  const { db } = require('./db');
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) return;

  const messages = {
    error: { title: `${serverName} crashed`, body: 'Server stopped unexpectedly.' },
  };
  const canStart = status === 'stopped' || status === 'error';
  const payload = JSON.stringify({ ...messages[status], url: `/server/${serverId}`, serverId, canStart });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

async function sendBroadcastPush(title, body, url = '/dashboard') {
  if (!_keys) return { sent: 0, failed: 0 };
  const { db } = require('./db');
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const payload = JSON.stringify({ title, body, url });
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
  return { sent, failed };
}

module.exports = { initVapid, getPublicKey, sendStatusPush, sendBroadcastPush };
