const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const router = express.Router();

// In-memory challenge store — { challenge → { userId, expires } }
const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}, 30000);

function origin(req) { return `${req.protocol}://${req.get('host')}`; }

// ── Registration (must be logged in) ─────────────────────────────────────────

router.post('/register/options', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const existing = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(req.user.id);

    const options = await generateRegistrationOptions({
      rpName: 'Nodactyl',
      rpID: req.hostname,
      userID: Buffer.from(user.id),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      excludeCredentials: existing.map(k => ({
        id: Buffer.from(k.credential_id, 'base64url'),
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    challenges.set(options.challenge, { userId: req.user.id, expires: Date.now() + 60000 });
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/register/verify', requireAuth, async (req, res) => {
  try {
    const { credential, name } = req.body;

    let foundChallenge = null;
    for (const [ch, data] of challenges) {
      if (data.userId === req.user.id && data.expires > Date.now()) { foundChallenge = ch; break; }
    }
    if (!foundChallenge) return res.status(400).json({ error: 'No pending registration — try again' });

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: foundChallenge,
      expectedOrigin: origin(req),
      expectedRPID: req.hostname,
    });

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

    challenges.delete(foundChallenge);

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    db.prepare('INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), req.user.id, Buffer.from(credentialID).toString('base64url'), Buffer.from(credentialPublicKey).toString('base64'), counter, (name || 'Passkey').slice(0, 64));

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Authentication (public) ───────────────────────────────────────────────────

router.post('/auth/options', async (req, res) => {
  try {
    const { username } = req.body || {};
    let allowCredentials = [];

    if (username) {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (user) {
        const keys = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(user.id);
        allowCredentials = keys.map(k => ({ id: Buffer.from(k.credential_id, 'base64url'), type: 'public-key' }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: req.hostname,
      allowCredentials,
      userVerification: 'preferred',
    });

    challenges.set(options.challenge, { userId: null, expires: Date.now() + 60000 });
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/verify', async (req, res) => {
  try {
    const { credential } = req.body;

    const clientData = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString());
    const challengeKey = clientData.challenge;
    const challengeData = challenges.get(challengeKey);
    if (!challengeData || challengeData.expires < Date.now()) return res.status(400).json({ error: 'Challenge expired — try again' });

    const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credential.id);
    if (!passkey) return res.status(400).json({ error: 'Passkey not recognised' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id);
    if (!user || user.suspended) return res.status(401).json({ error: 'Account suspended or not found' });

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeKey,
      expectedOrigin: origin(req),
      expectedRPID: req.hostname,
      authenticator: {
        credentialID: Buffer.from(passkey.credential_id, 'base64url'),
        credentialPublicKey: Buffer.from(passkey.public_key, 'base64'),
        counter: passkey.counter,
      },
    });

    if (!verification.verified) return res.status(400).json({ error: 'Passkey verification failed' });

    challenges.delete(challengeKey);
    db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, passkey.id);

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manage passkeys ───────────────────────────────────────────────────────────

router.get('/list', requireAuth, (req, res) => {
  const keys = db.prepare('SELECT id, name, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(keys);
});

router.delete('/:id', requireAuth, (req, res) => {
  const key = db.prepare('SELECT id FROM passkeys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!key) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM passkeys WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
