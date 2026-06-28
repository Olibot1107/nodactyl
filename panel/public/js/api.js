// Shared auth + fetch helpers

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

// ── PWA install prompt ────────────────────────────────────────────────────────
(function() {
  let _deferredPrompt = null;
  const DISMISSED_KEY = 'pwa-dismissed';

  const CSS = `
    #pwa-card {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      width: 320px;
      max-width: calc(100vw - 32px);
      background: #13141a;
      border: 1px solid rgba(249,115,22,.4);
      border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,.7), 0 0 0 1px rgba(249,115,22,.06), inset 0 1px 0 rgba(255,255,255,.04);
      padding: 20px;
      font-family: 'Inter', system-ui, sans-serif;
      transform: translateY(calc(100% + 28px));
      opacity: 0;
      transition: transform .4s cubic-bezier(.34,1.56,.64,1), opacity .3s ease;
    }
    #pwa-card.show {
      transform: translateY(0);
      opacity: 1;
    }
    #pwa-card-close {
      position: absolute;
      top: 12px; right: 12px;
      background: rgba(255,255,255,.06);
      border: none; border-radius: 50%;
      width: 26px; height: 26px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #9597b0; font-size: 13px;
      transition: background .15s, color .15s;
    }
    #pwa-card-close:hover { background: rgba(255,255,255,.12); color: #f1f2f6; }
    #pwa-card-head {
      display: flex; align-items: center; gap: 12px; margin-bottom: 14px;
    }
    #pwa-card-logo {
      width: 48px; height: 48px; border-radius: 12px; overflow: hidden; flex-shrink: 0;
      background: rgba(249,115,22,.12);
      display: flex; align-items: center; justify-content: center;
    }
    #pwa-card-logo img { width: 100%; height: 100%; object-fit: cover; }
    #pwa-card-name { font-size: 15px; font-weight: 700; color: #f1f2f6; line-height: 1.2; }
    #pwa-card-tagline { font-size: 11.5px; color: #9597b0; margin-top: 3px; }
    #pwa-card-perks {
      display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px;
    }
    .pwa-perk {
      font-size: 10.5px; font-weight: 600;
      background: rgba(255,255,255,.05);
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 99px; padding: 3px 9px;
      color: #9597b0;
    }
    #pwa-card-actions { display: flex; gap: 8px; }
    #pwa-card-install {
      flex: 1;
      background: #f97316;
      color: #fff;
      border: none; border-radius: 9px;
      padding: 9px 0;
      font-size: 13px; font-weight: 700;
      cursor: pointer;
      transition: background .15s, transform .1s, box-shadow .15s;
      box-shadow: 0 4px 12px rgba(249,115,22,.35);
    }
    #pwa-card-install:hover  { background: #ea6c09; box-shadow: 0 4px 18px rgba(249,115,22,.5); }
    #pwa-card-install:active { transform: scale(.97); }
    #pwa-card-later {
      background: rgba(255,255,255,.06);
      color: #9597b0;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 9px;
      padding: 9px 14px;
      font-size: 13px; font-weight: 600;
      cursor: pointer;
      transition: background .15s, color .15s;
    }
    #pwa-card-later:hover { background: rgba(255,255,255,.1); color: #f1f2f6; }
    #pwa-ios-steps {
      display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;
    }
    .pwa-ios-step {
      display: flex; align-items: center; gap: 10px;
      font-size: 12px; color: #9597b0;
    }
    .pwa-ios-step-num {
      width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
      background: rgba(249,115,22,.15); border: 1px solid rgba(249,115,22,.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; color: #f97316;
    }
    @media (max-width: 400px) {
      #pwa-card { bottom: 0; right: 0; width: 100%; max-width: 100%; border-radius: 20px 20px 0 0; }
      #pwa-card.show { transform: translateY(0); }
    }
  `;

  function isAlreadyInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  }

  function getAppName() {
    return (typeof getPanelSettings === 'function' && getPanelSettings()?.panel_name) || 'Nodactyl';
  }

  function injectCSS() {
    if (document.getElementById('pwa-css')) return;
    const s = document.createElement('style');
    s.id = 'pwa-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function dismissCard(remove) {
    localStorage.setItem(DISMISSED_KEY, '1');
    const card = document.getElementById('pwa-card');
    if (!card) return;
    card.classList.remove('show');
    setTimeout(() => card.remove(), 450);
  }

  function buildCard(bodyHtml, onInstall) {
    if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    if (isAlreadyInstalled()) return;
    if (document.getElementById('pwa-card')) return;
    injectCSS();

    const name = getAppName();
    const card = document.createElement('div');
    card.id = 'pwa-card';
    card.innerHTML = `
      <button id="pwa-card-close" title="Close">✕</button>
      <div id="pwa-card-head">
        <div id="pwa-card-logo"><img src="/favicon.svg" onerror="this.parentElement.textContent='⚡'"></div>
        <div>
          <div id="pwa-card-name">${name}</div>
          <div id="pwa-card-tagline">Install for the best experience</div>
        </div>
      </div>
      <div id="pwa-card-perks">
        <span class="pwa-perk">No browser UI</span>
        <span class="pwa-perk">Faster loads</span>
        <span class="pwa-perk">Works offline</span>
      </div>
      ${bodyHtml}
    `;
    document.body.appendChild(card);
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('show')));
    document.getElementById('pwa-card-close').onclick = () => dismissCard();
    if (onInstall) onInstall(card);
  }

  // Chrome / Edge / Android
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredPrompt = e;
    setTimeout(() => {
      buildCard(
        `<div id="pwa-card-actions">
          <button id="pwa-card-install">Install App</button>
          <button id="pwa-card-later">Not now</button>
        </div>`,
        card => {
          card.querySelector('#pwa-card-install').onclick = async () => {
            if (!_deferredPrompt) return;
            _deferredPrompt.prompt();
            const { outcome } = await _deferredPrompt.userChoice;
            _deferredPrompt = null;
            dismissCard();
          };
          card.querySelector('#pwa-card-later').onclick = () => dismissCard();
        }
      );
    }, 2500);
  });

  // iOS Safari
  window.addEventListener('load', () => {
    if (!/iphone|ipad|ipod/i.test(navigator.userAgent)) return;
    if (isAlreadyInstalled()) return;
    setTimeout(() => {
      buildCard(
        `<div id="pwa-ios-steps">
          <div class="pwa-ios-step"><span class="pwa-ios-step-num">1</span>Tap the <strong style="color:#f1f2f6">Share</strong> button at the bottom of Safari</div>
          <div class="pwa-ios-step"><span class="pwa-ios-step-num">2</span>Scroll down and tap <strong style="color:#f1f2f6">Add to Home Screen</strong></div>
          <div class="pwa-ios-step"><span class="pwa-ios-step-num">3</span>Tap <strong style="color:#f1f2f6">Add</strong> to confirm</div>
        </div>
        <div id="pwa-card-actions">
          <button id="pwa-card-later" style="flex:1">Got it</button>
        </div>`,
        card => { card.querySelector('#pwa-card-later').onclick = () => dismissCard(); }
      );
    }, 2500);
  });
})();

function getToken() { return localStorage.getItem('token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } }

function logout() {
  localStorage.clear();
  fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function requireAuth() {
  if (!getToken()) window.location.href = '/login';
}

function requireAdmin() {
  requireAuth();
  const user = getUser();
  if (user?.role !== 'admin') window.location.href = '/dashboard';
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('Could not reach the server. Check your connection.');
  }
  if (res.status === 401) { logout(); return; }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`Server returned an unexpected response (HTTP ${res.status}). The panel may be down.`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const API = {
  get:    (path)        => api('GET',    path),
  post:   (path, body)  => api('POST',   path, body),
  put:    (path, body)  => api('PUT',    path, body),
  patch:  (path, body)  => api('PATCH',  path, body),
  delete: (path, body)  => api('DELETE', path, body),
};

// ── Panel settings ────────────────────────────────────────────────────────────
let _panelSettings = { panel_name: 'Nodactyl', panel_logo: 'N' };

async function loadPanelSettings() {
  try {
    const r = await fetch('/api/settings/public');
    if (r.ok && (r.headers.get('content-type') || '').includes('application/json')) {
      const s = await r.json();
      if (s && typeof s === 'object') _panelSettings = { ..._panelSettings, ...s };
    }
  } catch {}
  if (_panelSettings.panel_name && _panelSettings.panel_name !== 'Nodactyl') {
    document.title = document.title.replace(/Nodactyl/g, _panelSettings.panel_name);
  }
  return _panelSettings;
}

function getPanelSettings() { return _panelSettings; }

// ── SVG icon library ─────────────────────────────────────────────────────────
const ICONS = {
  servers:    `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6" stroke-width="2" stroke-linecap="round"/><line x1="6" y1="18" x2="6.01" y2="18" stroke-width="2" stroke-linecap="round"/></svg>`,
  nodes:      `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.5"/><circle cx="4" cy="19" r="2.5"/><circle cx="20" cy="19" r="2.5"/><line x1="12" y1="7.5" x2="5" y2="17"/><line x1="12" y1="7.5" x2="19" y2="17"/></svg>`,
  users:      `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
  presets:    `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>`,
  allServers: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  audit:      `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>`,
  ranks:      `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  connectors: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
  settings:   `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  logout:     `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
  apikey:     `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M12 11.5l8-8M18 6l2 2M15 9l2 2"/></svg>`,
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(activePage) {
  const user = getUser();
  const isAdmin = user?.role === 'admin';
  const ps = getPanelSettings();

  const userNav = [
    { href: '/dashboard',  icon: ICONS.servers,    label: 'My Servers', key: 'dashboard' },
    ...((ps.discord_enabled === '1' || ps.github_enabled === '1') ? [{ href: '/connectors', icon: ICONS.connectors, label: 'Connectors', key: 'connectors' }] : []),
    ...(!isAdmin ? [{ href: '/nodes', icon: ICONS.nodes, label: 'Node Status', key: 'nodes' }] : []),
    ...(ps.api_enabled !== '0' ? [{ href: '/apikeys', icon: ICONS.apikey, label: 'API Keys', key: 'apikeys' }] : []),
  ];

  const adminNav = isAdmin ? [
    { href: '/admin/servers',    icon: ICONS.allServers,  label: 'All Servers',  key: 'admin-servers' },
    { href: '/admin/presets',    icon: ICONS.presets,     label: 'Presets',      key: 'admin-presets' },
    { href: '/admin/templates',  icon: ICONS.presets,     label: 'Templates',    key: 'admin-templates' },
    { href: '/admin/ranks',      icon: ICONS.ranks,       label: 'Ranks',        key: 'admin-ranks' },
    { href: '/admin/users',      icon: ICONS.users,       label: 'Users',        key: 'admin-users' },
    { href: '/nodes',            icon: ICONS.nodes,       label: 'Nodes',        key: 'nodes' },
    { href: '/admin/connectors', icon: ICONS.connectors,  label: 'Connectors',   key: 'admin-connectors' },
    { href: '/admin/audit',          icon: ICONS.audit,    label: 'Audit Log',      key: 'admin-audit' },
    { href: '/admin/settings',       icon: ICONS.settings, label: 'Settings',       key: 'admin-settings' },
  ] : [];

  const navItem = (n) => `
    <a href="${n.href}" class="nav-item ${activePage === n.key ? 'active' : ''}">
      <span class="nav-icon">${n.icon}</span> ${n.label}
    </a>`;

  // rank badge for sidebar footer
  const rank = user?.rank;
  const rankBadge = rank
    ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;background:${rank.color}22;color:${rank.color};border:1px solid ${rank.color}44">${esc(rank.name)}</span>`
    : '';

  // logo: if it looks like a URL, show as img; otherwise show as text
  const logoIsUrl = ps.panel_logo && (ps.panel_logo.startsWith('http') || ps.panel_logo.startsWith('/') || ps.panel_logo.startsWith('data:'));
  const logoHtml = logoIsUrl
    ? `<img src="${esc(ps.panel_logo)}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`
    : esc(ps.panel_logo || 'N');

  return `
    <button class="mobile-menu-btn" id="mobileMenuBtn" onclick="toggleMobileMenu()" aria-label="Open navigation">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeMobileMenu()"></div>
    <aside class="sidebar" id="appSidebar">
      <div class="sidebar-logo">
        <div class="logo-icon" style="overflow:hidden">${logoHtml}</div>
        <span class="logo-text">${esc(ps.panel_name || 'Nodactyl')}</span>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section-title">Servers</div>
        ${userNav.map(navItem).join('')}
        ${isAdmin ? `<div class="nav-divider"></div><div class="nav-section-title">Admin</div>${adminNav.map(navItem).join('')}` : ''}
      </nav>
      <div class="sidebar-footer">
        <div class="user-chip" onclick="location.href='/account'" style="cursor:pointer" title="My Account">
          <div class="user-avatar" style="overflow:hidden">${user?.avatar ? `<img src="${esc(user.avatar)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt="">` : (user?.username?.[0] || '?').toUpperCase()}</div>
          <div class="user-info">
            <div class="user-name">${esc(user?.username || '')}</div>
            <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
              ${rankBadge || `<span class="user-role">${user?.role || ''}</span>`}
            </div>
          </div>
          <button class="logout-btn" onclick="event.stopPropagation();logout()" title="Log out">${ICONS.logout}</button>
        </div>
      </div>
    </aside>`;
}

function toggleMobileMenu() {
  const sidebar = document.getElementById('appSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('open');
  overlay?.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeMobileMenu() {
  document.getElementById('appSidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Convert ANSI escape sequences to HTML <span> elements.
// Handles SGR codes: reset (0), bold (1), dim (2), standard + bright foreground colours.
// HTML special characters in the text are escaped so it's safe for innerHTML.
function ansiToHtml(raw) {
  const FG = {
    30:'#555e6d', 31:'#f87171', 32:'#4ade80', 33:'#facc15',
    34:'#60a5fa', 35:'#c084fc', 36:'#22d3ee', 37:'#c8d3e0',
    90:'#6b7280', 91:'#fca5a5', 92:'#86efac', 93:'#fde68a',
    94:'#93c5fd', 95:'#d8b4fe', 96:'#67e8f9', 97:'#f9fafb',
  };
  const s = String(raw);
  let html = '';
  let open = 0;
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x1b) {
      const next = s[i + 1];
      if (next === '[') {
        // CSI sequence — scan to final byte (0x40–0x7e)
        let j = i + 2;
        while (j < s.length && (s.charCodeAt(j) < 0x40 || s.charCodeAt(j) > 0x7e)) j++;
        if (s[j] === 'm') {
          const codes = s.slice(i + 2, j).split(';').map(Number);
          for (const n of codes) {
            if (n === 0 || isNaN(n)) { html += '</span>'.repeat(open); open = 0; }
            else if (FG[n])  { html += `<span style="color:${FG[n]}">`;  open++; }
            else if (n === 1){ html += `<span style="font-weight:700">`; open++; }
            else if (n === 2){ html += `<span style="opacity:.6">`;      open++; }
          }
        }
        // Skip entire CSI sequence regardless of type
        i = j + 1;
      } else if (next === ']') {
        // OSC sequence — ends at BEL or ESC backslash
        const bel = s.indexOf('\x07', i + 2);
        i = bel === -1 ? s.length : bel + 1;
      } else {
        // Other 2-char escape (ESC =, ESC >, ESC 7, etc.) — skip
        i += next ? 2 : 1;
      }
    } else if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      // Strip other control characters (keep tab + newline)
      i++;
    } else {
      const c = s[i++];
      if      (c === '&') html += '&amp;';
      else if (c === '<') html += '&lt;';
      else if (c === '>') html += '&gt;';
      else                html += c;
    }
  }
  return html + '</span>'.repeat(open);
}

function badgeHtml(status) {
  const map = {
    running:     'badge-running',
    stopped:     'badge-stopped',
    stopping:    'badge-installing',
    starting:    'badge-installing',
    installing:  'badge-installing',
    error:       'badge-error',
    online:      'badge-online',
    offline:     'badge-offline',
    node_offline:'badge-offline',
  };
  return `<span class="badge ${map[status] || 'badge-stopped'}">${esc(status)}</span>`;
}

function copyText(text, el) {
  navigator.clipboard.writeText(text);
  const orig = el.textContent;
  el.textContent = 'Copied';
  setTimeout(() => { el.textContent = orig; }, 1500);
}

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function renderServerNav(serverId, active, server) {
  const enableMods     = server ? (server.enable_mods     ?? 1) : 1;
  const enablePackages = server ? (server.enable_packages ?? 1) : 1;
  const tabs = [
    { key: 'console', label: 'Console', href: `/server/${serverId}`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>` },
    { key: 'files',   label: 'Files',   href: `/server/${serverId}/files`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>` },
    { key: 'mods', label: 'Mods', href: `/server/${serverId}/mods`, hidden: !enableMods,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="8.5" x2="22" y2="8.5"/><line x1="2" y1="15.5" x2="22" y2="15.5"/></svg>` },
    { key: 'packages', label: 'Packages', href: `/server/${serverId}/packages`, hidden: !enablePackages,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M21 10V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l2-1.14"/><path d="M16.5 9.4l-9-5.19M12 12l-9-5.19M12 12v9"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M20.27 17.27L22 19"/></svg>` },
    { key: 'settings',label: 'Settings',href: `/server/${serverId}/settings`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>` },
    { key: 'activity', label: 'Activity', href: `/server/${serverId}/activity`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>` },
  ];
  return `<nav class="server-nav">${tabs.filter(t => !t.hidden).map(t =>
    `<a class="server-nav-item ${active === t.key ? 'active' : ''}" href="${t.href}">${t.icon} ${t.label}</a>`
  ).join('')}</nav>`;
}
