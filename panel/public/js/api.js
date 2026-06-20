// Shared auth + fetch helpers

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
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const API = {
  get:    (path)       => api('GET',    path),
  post:   (path, body) => api('POST',   path, body),
  put:    (path, body) => api('PUT',    path, body),
  patch:  (path, body) => api('PATCH',  path, body),
  delete: (path)       => api('DELETE', path),
};

// ── Panel settings ────────────────────────────────────────────────────────────
let _panelSettings = { panel_name: 'Nodactyl', panel_logo: 'N' };

async function loadPanelSettings() {
  try {
    const s = await fetch('/api/settings/public').then(r => r.json());
    if (s && typeof s === 'object') _panelSettings = { ..._panelSettings, ...s };
  } catch {}
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
  ranks:      `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  settings:   `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  logout:     `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(activePage) {
  const user = getUser();
  const isAdmin = user?.role === 'admin';
  const ps = getPanelSettings();

  const userNav = [
    { href: '/dashboard', icon: ICONS.servers, label: 'My Servers', key: 'dashboard' },
    ...(!isAdmin ? [{ href: '/nodes', icon: ICONS.nodes, label: 'Node Status', key: 'nodes' }] : []),
  ];

  const adminNav = isAdmin ? [
    { href: '/admin/servers',  icon: ICONS.allServers, label: 'All Servers',  key: 'admin-servers' },
    { href: '/admin/presets',  icon: ICONS.presets,    label: 'Presets',      key: 'admin-presets' },
    { href: '/admin/ranks',    icon: ICONS.ranks,      label: 'Ranks',        key: 'admin-ranks' },
    { href: '/admin/users',    icon: ICONS.users,      label: 'Users',        key: 'admin-users' },
    { href: '/nodes',          icon: ICONS.nodes,      label: 'Nodes',        key: 'nodes' },
    { href: '/admin/settings', icon: ICONS.settings,   label: 'Settings',     key: 'admin-settings' },
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
    <aside class="sidebar">
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

function renderServerNav(serverId, active) {
  const tabs = [
    { key: 'console', label: 'Console', href: `/server/${serverId}`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>` },
    { key: 'files',   label: 'Files',   href: `/server/${serverId}/files`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>` },
    { key: 'settings',label: 'Settings',href: `/server/${serverId}/settings`,
      icon: `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>` },
  ];
  return `<nav class="server-nav">${tabs.map(t =>
    `<a class="server-nav-item ${active === t.key ? 'active' : ''}" href="${t.href}">${t.icon} ${t.label}</a>`
  ).join('')}</nav>`;
}
