// Shared auth + fetch helpers

function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

function logout() {
  localStorage.clear();
  fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function requireAuth() {
  if (!getToken()) window.location.href = '/login';
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const API = {
  get: (path) => api('GET', path),
  post: (path, body) => api('POST', path, body),
  delete: (path) => api('DELETE', path),
};

function renderSidebar(activePage) {
  const user = getUser();
  const isAdmin = user?.role === 'admin';

  const nav = [
    { href: '/dashboard', icon: '⚡', label: 'Servers', key: 'dashboard' },
    ...(isAdmin ? [{ href: '/nodes', icon: '🖥️', label: 'Nodes', key: 'nodes' }] : []),
  ];

  return `
    <aside class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-icon">🦕</div>
        <span class="logo-text">Nodactyl</span>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section-title">Management</div>
        ${nav.map(n => `
          <a href="${n.href}" class="nav-item ${activePage === n.key ? 'active' : ''}">
            <span class="icon">${n.icon}</span> ${n.label}
          </a>`).join('')}
      </nav>
      <div class="sidebar-footer">
        <div class="user-chip">
          <div class="user-avatar">${(user?.username?.[0] || '?').toUpperCase()}</div>
          <div class="user-info">
            <div class="user-name">${user?.username || ''}</div>
            <div class="user-role">${user?.role || ''}</div>
          </div>
          <button class="logout-btn" onclick="logout()" title="Logout">⏻</button>
        </div>
      </div>
    </aside>`;
}

function badgeHtml(status) {
  const map = {
    running:    'badge-running',
    stopped:    'badge-stopped',
    installing: 'badge-installing',
    error:      'badge-error',
    online:     'badge-online',
    offline:    'badge-offline',
    node_offline: 'badge-offline',
  };
  return `<span class="badge ${map[status] || 'badge-stopped'}">${status}</span>`;
}

function copyText(text, el) {
  navigator.clipboard.writeText(text);
  const orig = el.textContent;
  el.textContent = 'Copied!';
  setTimeout(() => { el.textContent = orig; }, 1500);
}
