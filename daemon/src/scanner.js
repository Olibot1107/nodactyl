const path = require('path');
const fs = require('fs');

// ── Filename-level blocks ────────────────────────────────────────────────────

const BLOCKED_EXTENSIONS = new Set(['.ovpn', '.torrent']);

const BLOCKED_FILENAME_PATTERNS = [
  /^wg\d*\.conf$/i,        // WireGuard: wg0.conf, wg1.conf
  /^wireguard.*\.conf$/i,
  /^znc\.conf$/i,          // ZNC IRC bouncer
  /^torrc$/i,              // Tor daemon config
  /^proxychains.*\.conf$/i,
];

// ── Static content rules ─────────────────────────────────────────────────────
// High-confidence: a single match is enough to block.
// Each rule: { id, reason, test(content) }

const CONTENT_RULES = [
  // ── VPN / Proxy tunnels ──
  {
    id: 'wireguard',
    reason: 'WireGuard VPN configuration',
    test: c => /\[Interface\][\s\S]{0,300}PrivateKey\s*=/.test(c),
  },
  {
    id: 'openvpn-key',
    reason: 'OpenVPN static key',
    test: c => /-----BEGIN OpenVPN Static key/.test(c),
  },
  {
    id: 'openvpn-client',
    reason: 'OpenVPN client configuration',
    test: c => /^client$/m.test(c) && /^dev tun/m.test(c) && /^remote\s+/m.test(c),
  },
  {
    id: 'openvpn-server',
    reason: 'OpenVPN server configuration',
    test: c => /^mode server$/m.test(c) && /^dev tun/m.test(c),
  },
  {
    id: 'shadowsocks',
    reason: 'Shadowsocks proxy',
    test: c => /"server_port"\s*:/.test(c) && /"method"\s*:/.test(c) && /"password"\s*:/.test(c),
  },
  {
    id: 'v2ray',
    reason: 'V2Ray/Xray proxy',
    test: c => /"protocol"\s*:\s*"(vmess|vless|trojan)"/.test(c),
  },
  {
    id: 'clash',
    reason: 'Clash proxy configuration',
    test: c => /^proxies:\s*$/m.test(c) && /- \{?name:/.test(c),
  },
  {
    id: 'hysteria',
    reason: 'Hysteria/Hysteria2 proxy',
    test: c => /"obfs"\s*:/.test(c) && /"up_mbps"\s*:/.test(c),
  },
  {
    id: 'trojan-gfw',
    reason: 'Trojan-GFW proxy',
    test: c => /"run_type"\s*:\s*"(client|server)"/.test(c) && /"ssl"\s*:/.test(c) && /"password"\s*:\s*\[/.test(c),
  },
  {
    id: 'squid',
    reason: 'Squid HTTP proxy server',
    test: c => /^http_port\s+\d+/m.test(c) && /^acl\s+\w+\s+/m.test(c) && /^http_access\s+/.test(c),
  },
  {
    id: '3proxy',
    reason: '3proxy server',
    test: c => /^(proxy|socks|tcppm)\s+-p\d+/m.test(c),
  },
  {
    id: 'dante',
    reason: 'Dante SOCKS proxy server',
    test: c => /^socksmethod\s*:/m.test(c) && /^clientmethod\s*:/m.test(c),
  },

  // ── Crypto miners ──
  {
    id: 'xmrig-config',
    reason: 'XMRig crypto miner',
    test: c => /"algo"\s*:\s*"(randomx|cryptonight|rx\/0|cn\/)/.test(c) && /"pools"\s*:/.test(c),
  },
  {
    id: 'stratum',
    reason: 'Crypto mining stratum protocol',
    test: c => /stratum\+tcp:\/\//.test(c) || /stratum\+ssl:\/\//.test(c),
  },
  {
    id: 'cpuminer',
    reason: 'CPU miner configuration',
    test: c => /"url"\s*:\s*"[^"]*stratum/.test(c) || /--algo\s+cryptonight/.test(c),
  },
  {
    id: 'ethminer',
    reason: 'Ethereum miner configuration',
    test: c => /--farm-recheck/.test(c) && /--stratum/.test(c),
  },

  // ── Tor ──
  {
    id: 'tor-relay',
    reason: 'Tor relay configuration',
    test: c => /^ORPort\s+\d+/m.test(c) && /^Nickname\s+/m.test(c),
  },
  {
    id: 'tor-hidden',
    reason: 'Tor hidden service',
    test: c => /^HiddenServiceDir\s+/m.test(c) && /^HiddenServicePort\s+/m.test(c),
  },

  // ── Reverse shells / RATs ──
  {
    id: 'revshell-bash',
    reason: 'Bash reverse shell',
    test: c => /bash\s+-i\s+>&?\s*\/dev\/tcp\//.test(c),
  },
  {
    id: 'revshell-python',
    reason: 'Python reverse shell',
    test: c => /socket\.connect\s*\(\s*\(/.test(c) && /os\.dup2\s*\(/.test(c),
  },
  {
    id: 'revshell-nc',
    reason: 'Netcat reverse shell',
    test: c => /nc\s+(-e|-c)\s+['"]?\/bin\/(ba)?sh/.test(c) || /ncat\s+--exec\s+\/bin\/(ba)?sh/.test(c),
  },
  {
    id: 'revshell-php',
    reason: 'PHP reverse shell',
    test: c => /fsockopen\s*\([^)]+\).*shell_exec|passthru|system/.test(c) &&
               /\$sock\s*=\s*fsockopen/.test(c),
  },
  {
    id: 'msf-payload',
    reason: 'Metasploit-style payload',
    test: c => /meterpreter/.test(c) || /MSF_PAYLOAD/.test(c) || /Msf::Exploit/.test(c),
  },

  // ── Torrent clients/daemons ──
  {
    id: 'transmission',
    reason: 'Transmission torrent daemon',
    test: c => /"download-dir"\s*:/.test(c) && /"rpc-port"\s*:/.test(c) && /"speed-limit/.test(c),
  },
  {
    id: 'qbittorrent',
    reason: 'qBittorrent configuration',
    test: c => /\[BitTorrent\]/.test(c) && /Session\\DefaultSavePath/.test(c),
  },
  {
    id: 'rtorrent',
    reason: 'rTorrent configuration',
    test: c => /^directory\.default\.set\s*=/m.test(c) && /^network\.port_range\.set/m.test(c),
  },

  // ── IRC bouncers ──
  {
    id: 'znc',
    reason: 'ZNC IRC bouncer',
    test: c => /<User\s+/i.test(c) && /<Network\s+/i.test(c),
  },
  {
    id: 'irssi-proxy',
    reason: 'irssi proxy module',
    test: c => /load proxy/.test(c) && /irssiproxy_/.test(c),
  },

  // ── Forums / CMS ──
  {
    id: 'phpbb',
    reason: 'phpBB forum software',
    test: c => /\$phpbb_root_path\s*=/.test(c) || /define\s*\(\s*['"]PHPBB_VERSION['"]/.test(c),
  },
  {
    id: 'mybb',
    reason: 'MyBB forum software',
    test: c => /define\s*\(\s*['"]IN_MYBB['"]/.test(c),
  },
  {
    id: 'xenforo',
    reason: 'XenForo forum software',
    test: c => /XenForo_Application::initialize/.test(c) || /class XenForo_[A-Z]/.test(c),
  },
  {
    id: 'vbulletin',
    reason: 'vBulletin forum software',
    test: c => /define\s*\(\s*['"]VB_AREA['"]/.test(c),
  },
  {
    id: 'discourse',
    reason: 'Discourse forum software',
    test: c => /^require\s+['"]discourse_/m.test(c) || /Discourse\.Application\.create/.test(c),
  },
  {
    id: 'wordpress',
    reason: 'WordPress CMS',
    test: c => /define\s*\(\s*['"]WPINC['"]/.test(c) || /\$wpdb\s*=\s*new\s+wpdb/.test(c),
  },
  {
    id: 'joomla',
    reason: 'Joomla CMS',
    test: c => /defined\s*\(\s*['"]_JEXEC['"]/.test(c) || /JFactory::getApplication\s*\(/.test(c),
  },
  {
    id: 'drupal',
    reason: 'Drupal CMS',
    test: c => /drupal_bootstrap\s*\(/.test(c) && /\$databases\b/.test(c),
  },

  // ── DDoS / attack tools ──
  {
    id: 'loic',
    reason: 'LOIC/HOIC DDoS tool',
    test: c => /Low Orbit Ion Cannon|High Orbit Ion Cannon/i.test(c),
  },
  {
    id: 'slowloris',
    reason: 'Slowloris HTTP flood tool',
    test: c => /slowloris/i.test(c) && /send_line|socket_list/i.test(c),
  },
];

// ── Heuristic scoring engine ─────────────────────────────────────────────────
// Signals that are individually ambiguous but together indicate prohibited use.
// Once accumulated score >= BLOCK_THRESHOLD the file is blocked and all
// triggered signals are listed in the rejection reason.

const BLOCK_THRESHOLD = 8;

// Script extensions — entropy matters more here
const SCRIPT_EXT = new Set(['.js', '.ts', '.py', '.php', '.rb', '.pl', '.sh', '.bash', '.lua']);

function shannonEntropy(str) {
  if (str.length < 32) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  const len = str.length;
  let e = 0;
  for (const n of Object.values(freq)) { const p = n / len; e -= p * Math.log2(p); }
  return e;
}

// Each signal: { id, signal (human label), score, test(content, meta) }
// meta = { entropy, isScript }
const SIGNALS = [
  // ── Definitive single-signal blocks ──
  {
    id: 'mining-pool-domain',
    signal: 'known mining pool domain',
    score: 9,
    test: c => /\b(nanopool|f2pool|slushpool|antpool|nicehash|minergate|2miners|ethermine|hiveon)\b/i.test(c),
  },
  {
    id: 'xmr-wallet',
    signal: 'Monero wallet address',
    score: 9,
    // XMR addresses start with 4 and are 95 chars (standard) or 106 chars (subaddress starting with 8)
    test: c => /\b4[0-9A-Za-z]{93}\b/.test(c),
  },

  // ── Medium signals (need 2+ to block) ──
  {
    id: 'obfuscated-exec',
    signal: 'obfuscated code with dynamic execution',
    score: 6,
    test: (c, m) => m.entropy > 5.7 && /\beval\s*\(|\bFunction\s*\(["']/.test(c),
  },
  {
    id: 'base64-dropper',
    signal: 'base64-encoded payload with exec',
    score: 6,
    test: c => {
      const blobs = (c.match(/[A-Za-z0-9+/]{80,}={0,2}/g) || []).filter(b => b.length >= 80);
      return blobs.length >= 3 && /\beval\s*\(|\bexec\s*\(/.test(c);
    },
  },
  {
    id: 'high-entropy-script',
    signal: 'heavily obfuscated script',
    score: 5,
    test: (c, m) => m.isScript && m.entropy > 6.1,
  },
  {
    id: 'irc-bot',
    signal: 'IRC bot command pattern',
    score: 6,
    test: c => /\bPRIVMSG\b/.test(c) && /\bJOIN\b/.test(c) && /\bNICK\b/.test(c) && /\bPASS\b/.test(c),
  },
  {
    id: 'socks-listener',
    signal: 'SOCKS proxy listener code',
    score: 5,
    test: c => /SOCKS5?_VERSION|socks5?\s+proxy/i.test(c) && /\.listen\s*\(/.test(c),
  },
  {
    id: 'port-scan',
    signal: 'port scanning activity',
    score: 5,
    test: c => /socket\.connect\s*\(\s*\([^)]+,\s*\d+\s*\)/.test(c) && /range\s*\(\s*1\s*,\s*(?:65535|65536)\s*\)/.test(c),
  },
  {
    id: 'credential-stealer',
    signal: 'credential harvesting pattern',
    score: 6,
    test: c => /document\.cookie/.test(c) && /XMLHttpRequest|fetch\s*\(/.test(c) && /\.(send|post)\s*\(/.test(c) && /attacker|exfil/i.test(c),
  },
  {
    id: 'suspicious-network-spawn',
    signal: 'network connection with subprocess exec',
    score: 4,
    test: c => /\/dev\/tcp\//.test(c) && /exec|spawn|popen/i.test(c),
  },
  {
    id: 'crypto-mining-algo',
    signal: 'cryptocurrency mining algorithm reference',
    score: 5,
    test: c => /\b(randomx|cryptonight|equihash|kawpow|firopow|progpow|ethash)\b/i.test(c),
  },
  {
    id: 'btc-wallet',
    signal: 'Bitcoin wallet address with suspicious context',
    score: 4,
    // Only count when near mining/payment keywords to reduce false positives
    test: c => /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/.test(c) &&
               /\b(mine|miner|mining|pool|hashrate|wallet|payout)\b/i.test(c),
  },
];

// ── File type helpers ────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  '.txt', '.json', '.yaml', '.yml', '.conf', '.config', '.cfg', '.ini',
  '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts',
  '.php', '.rb', '.pl', '.lua', '.env', '.properties', '.toml', '.xml',
  '.html', '.htm', '.css', '.md', '.ovpn', '.key', '.pem', '.crt', '.cer',
]);

function isTextFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === '';
}

// ── Public API ───────────────────────────────────────────────────────────────

function checkFilename(filename) {
  const base = path.basename(filename);
  const ext = path.extname(base).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) return { blocked: true, reason: `Blocked file type: ${ext}` };
  for (const pat of BLOCKED_FILENAME_PATTERNS) {
    if (pat.test(base)) return { blocked: true, reason: `Blocked filename: ${base}` };
  }
  return { blocked: false };
}

function checkContent(filename, content) {
  const fnResult = checkFilename(filename);
  if (fnResult.blocked) return fnResult;
  if (!isTextFile(filename)) return { blocked: false };

  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);

  // 1. Static high-confidence rules
  for (const rule of CONTENT_RULES) {
    if (rule.test(text)) return { blocked: true, reason: rule.reason, rule: rule.id };
  }

  // 2. Heuristic multi-signal scoring
  const ext = path.extname(filename).toLowerCase();
  const meta = {
    entropy: text.length > 128 ? shannonEntropy(text) : 0,
    isScript: SCRIPT_EXT.has(ext),
  };

  let totalScore = 0;
  const triggered = [];
  for (const sig of SIGNALS) {
    if (sig.test(text, meta)) {
      totalScore += sig.score;
      triggered.push(sig.signal);
    }
  }

  if (totalScore >= BLOCK_THRESHOLD) {
    return {
      blocked: true,
      reason: `Suspicious content (score ${totalScore}): ${triggered.join(', ')}`,
      rule: 'heuristic',
    };
  }

  return { blocked: false };
}

function scanDirectory(dir, maxFiles = 500) {
  let count = 0;

  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return null; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git, .svn, etc.

      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.isFile()) {
        if (++count > maxFiles) return null;

        const rel = path.relative(dir, full);
        const fnResult = checkFilename(entry.name);
        if (fnResult.blocked) return { ...fnResult, file: rel };

        if (!isTextFile(entry.name)) continue;

        let text;
        try {
          const { size } = fs.statSync(full);
          if (size > 512 * 1024) continue; // skip files > 512 KB
          text = fs.readFileSync(full, 'utf8');
        } catch { continue; }

        const result = checkContent(entry.name, text);
        if (result.blocked) return { ...result, file: rel };
      }
    }
    return null;
  }

  return walk(dir);
}

module.exports = { checkFilename, checkContent, scanDirectory, shannonEntropy };
