import { state, els } from '../state.js';
import { request, authHeaders } from '../services/request.js';
import { formatDateTime, formatReportReason, coverSrc, truncateText } from '../utils/format.js';
import { emptyHtml, showToast, updateModalBodyLock } from '../utils/dom.js';

export function bindAdminActions() {
  els.adminShowEnabledSourcesBtn?.addEventListener('click', () => { state.admin.sourceSubTab = 'enabled'; renderAdminSourcesSubTabs(); });
  els.adminShowAllSourcesBtn?.addEventListener('click', () => { state.admin.sourceSubTab = 'all'; renderAdminSourcesSubTabs(); });
  document.getElementById('adminFetchAllSourcesBtn')?.addEventListener('click', async () => {
    try {
      const d = await request('/api/admin/sources/remote');
      state.admin.allSuwayomiSources = d.sources || []; renderAdminAllSources();
    } catch (err) { showToast(err.message); }
  });
}

export async function loadAdminData() {
  if (!state.user?.isAdmin) return;
  
  const safeReq = async (url) => {
    try {
      return await request(url, { headers: authHeaders(false) });
    } catch (e) {
      console.error(`Error loading ${url}:`, e);
      return {};
    }
  };

  try {
    const [ov, sync, rep, users, feed, comm, banM, banU, health] = await Promise.all([
      safeReq('/api/admin/overview'),
      safeReq('/api/admin/sync/status'),
      safeReq('/api/admin/reports'),
      safeReq('/api/admin/users'),
      safeReq('/api/admin/feedback'),
      safeReq('/api/admin/comments'),
      safeReq('/api/admin/banned-mangas'),
      safeReq('/api/admin/banned-users'),
      safeReq('/api/admin/catalog/health')
    ]);

    state.admin.stats = ov.stats || {};
    state.admin.syncStatus = sync.sync || {};
    state.admin.reports = rep.reports || [];
    state.admin.users = users.users || [];
    state.admin.feedback = feed.feedback || [];
    state.admin.comments = comm.comments || [];
    state.admin.bannedMangas = banM.bannedMangas || [];
    state.admin.bannedUsers = banU.bannedUsers || banU.users || [];
    state.admin.catalogHealth = health.health || {};
    
    renderAdmin();
  } catch (err) { 
    console.error('Critical error in loadAdminData:', err); 
  }
}

export function renderAdmin() {
  renderAdminTabs(); renderAdminStats(); renderAdminSyncStatus(); renderAdminCatalogHealth(); renderAdminUsers();
  renderAdminReports(); renderAdminFeedback(); renderAdminComments();
  renderAdminBannedMangas(); renderAdminBannedUsers(); renderAdminSourcesSubTabs();
}

export function renderAdminTabs() {
  const active = state.admin.activeTab || 'overview';
  if (els.adminSubTabs) els.adminSubTabs.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.toggle('active', b.dataset.adminTab === active));
  if (els.adminView) els.adminView.querySelectorAll('[data-admin-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.adminPanel !== active));
}

export function renderAdminStats() {
  const s = state.admin.stats || {};
  const cards = [
    { label: 'Users', v: s.usersCount, t: 'users' }, { label: 'Reports', v: s.pendingReportsCount, t: 'reports' },
    { label: 'Feedback', v: s.pendingFeedbackCount, t: 'feedback' }, { label: 'Manga', v: s.mangasCount, t: 'catalog' }
  ];
  els.adminStats.innerHTML = cards.map(c => `<div class="stat-card" data-action="admin-switch-tab" data-admin-tab="${c.t}"><p class="stat-value">${c.v || 0}</p><p class="stat-label">${c.label}</p></div>`).join('');
}

export function renderAdminUsers() {
  if (!els.adminUsersList) return;
  els.adminUsersList.innerHTML = (state.admin.users || []).map(u => `
    <div class="settings-cat-row">
      <p><strong>${u.username}</strong> (${u.email}) - ${u.isAdmin ? 'Admin' : 'User'}</p>
      <div class="inline-tools">
        <button class="btn" data-action="toggle-admin-user" data-user-id="${u.id}" data-next-admin="${u.isAdmin?0:1}">${u.isAdmin?'Remove Admin':'Make Admin'}</button>
      </div>
    </div>
  `).join('') || emptyHtml('No users.');
}

export function renderAdminReports() {
  if (!els.adminReportsList) return;
  els.adminReportsList.innerHTML = (state.admin.reports || []).map(r => `
    <div class="settings-cat-row settings-list-col">
      <p>#${r.id} - ${r.reason} in ${r.targetType}</p>
      <p>${r.details || ''}</p>
      <div class="inline-tools">
        <button class="btn btn-danger" data-action="admin-delete-report" data-report-id="${r.id}">Delete</button>
        <button class="btn" data-action="open-details" data-manga-id="${r.targetId}">View</button>
      </div>
    </div>
  `).join('') || emptyHtml('No reports.');
}

export function renderAdminFeedback() {
  if (!els.adminFeedbackList) return;
  els.adminFeedbackList.innerHTML = (state.admin.feedback || []).map(f => `
    <div class="settings-cat-row settings-list-col">
      <p><strong>${f.username}</strong> - ${f.category}</p>
      <p>${f.message}</p>
      <div class="inline-tools">
        <button class="btn btn-danger" data-action="admin-delete-feedback" data-feedback-id="${f.id}">Delete</button>
      </div>
    </div>
  `).join('') || emptyHtml('No feedback.');
}

export function renderAdminComments() {
  if (!els.adminCommentsList) return;
  els.adminCommentsList.innerHTML = (state.admin.comments || []).map(c => `
    <div class="settings-cat-row settings-list-col">
      <p><strong>${c.username}</strong> in ${c.mangaTitle}</p>
      <p>${c.body}</p>
      <div class="inline-tools">
        <button class="btn btn-danger" data-action="admin-delete-comment" data-comment-id="${c.id}">Remove</button>
      </div>
    </div>
  `).join('') || emptyHtml('No comments.');
}

export function renderAdminBannedMangas() {
  if (!els.adminBannedMangasList) return;
  els.adminBannedMangasList.innerHTML = (state.admin.bannedMangas || []).map(m => `
    <div class="settings-cat-row">
      <p><strong>ID: ${m.mangaId || m.manga_id}</strong> - ${m.title || m.mangaTitle || 'Banned Manga'}</p>
      <button class="btn" data-action="admin-unban-manga" data-manga-id="${m.id}">Unban</button>
    </div>
  `).join('') || emptyHtml('No banned manga.');
}

export function renderAdminBannedUsers() {
  if (!els.adminBannedUsersList) return;
  els.adminBannedUsersList.innerHTML = (state.admin.bannedUsers || []).map(u => `
    <div class="settings-cat-row">
      <p><strong>${u.username || 'User ID: ' + (u.userId || u.user_id)}</strong> (${u.email || ''})</p>
      <button class="btn" data-action="admin-unban-user" data-user-id="${u.id}">Unban</button>
    </div>
  `).join('') || emptyHtml('No banned users.');
}

export function renderAdminSyncStatus() {
  if (!els.adminSyncStatus) return;
  const s = state.admin.syncStatus || {};
  els.adminSyncStatus.innerHTML = `<p>Sync: ${s.running ? 'Running' : 'Stopped'} - Last: ${formatDateTime(s.endedAt)}</p>`;
}

export function renderAdminCatalogHealth() {
  if (!els.adminCatalogHealth) return;
  const h = state.admin.catalogHealth || {};
  const stats = [
    { label: 'Total Manga', v: h.totalMangas },
    { label: 'No Cover', v: h.missingCover },
    { label: 'No Description', v: h.missingDescription },
    { label: 'No Genres', v: h.missingGenres },
    { label: 'Duplicates', v: h.duplicatedTitleGroups }
  ];
  els.adminCatalogHealth.innerHTML = stats.map(s => `
    <div class="stat-card">
      <p class="stat-value">${s.v || 0}</p>
      <p class="stat-label">${s.label}</p>
    </div>
  `).join('');
}

export function renderAdminSourcesSubTabs() {
  const sub = state.admin.sourceSubTab || 'enabled';
  els.adminShowEnabledSourcesBtn?.classList.toggle('active', sub === 'enabled');
  els.adminShowAllSourcesBtn?.classList.toggle('active', sub === 'all');
  els.adminEnabledSourcesSubPanel?.classList.toggle('hidden', sub !== 'enabled');
  els.adminAllSourcesSubPanel?.classList.toggle('hidden', sub !== 'all');
  if (sub === 'enabled') renderAdminEnabledSources(); else renderAdminAllSources();
}

export function renderAdminEnabledSources() {
  if (!els.adminEnabledSourcesList) return;
  els.adminEnabledSourcesList.innerHTML = (state.admin.enabledSources || []).map(s => `
    <div class="settings-cat-row">
      <p>${s.source_name} (${s.lang})</p>
      <div class="inline-tools">
        <button class="btn" data-action="admin-view-source-mangas" data-source-id="${s.source_id}" data-source-name="${s.source_name}">View Manga</button>
        <button class="btn btn-danger" data-action="admin-delete-source" data-source-id="${s.source_id}">Delete</button>
      </div>
    </div>
  `).join('') || emptyHtml('No enabled sources.');
}

export function renderAdminAllSources() {
  if (!els.adminAllSourcesList) return;
  els.adminAllSourcesList.innerHTML = (state.admin.allSuwayomiSources || []).map(s => `
    <div class="settings-cat-row">
      <p>${s.name} (${s.lang})</p>
      <button class="btn btn-primary" data-action="admin-toggle-source" data-source-id="${s.id}" data-source-name="${s.name}" data-lang="${s.lang}" data-next-state="enable" data-provider="suwayomi">Enable</button>
    </div>
  `).join('') || emptyHtml('Click on List Sources.');
}

export function switchAdminTab(t) { 
  state.admin.activeTab = t; 
  renderAdmin(); 
  if (t === 'sources') loadAdminEnabledSources(); 
  if (t === 'sync') loadAdminData();
}
export async function loadAdminEnabledSources() { try { const d = await request('/api/admin/sources'); state.admin.enabledSources = d.sources || []; renderAdminEnabledSources(); } catch (err) { showToast(err.message); } }
export async function handleAdminToggleSource(id, name, lang, next, prov) { try { await request('/api/admin/sources', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ sourceId: id, sourceName: name, lang, provider: prov, isActive: next === 'enable' }) }); showToast('Source updated.'); await loadAdminEnabledSources(); } catch (err) { showToast(err.message); } }
export async function handleAdminDeleteSource(id) { if (confirm('Delete source?')) { await request(`/api/admin/sources/${id}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminEnabledSources(); } }
export async function handleAdminRunSync() { await request('/api/admin/sync/run', { method: 'POST', headers: authHeaders() }); showToast('Sync started.'); }
export async function handleAdminRefreshSyncStatus() { const d = await request('/api/admin/sync/status', { headers: authHeaders(false) }); state.admin.syncStatus = d.sync; renderAdminSyncStatus(); }
export async function handleAdminDeleteReport(id) { await request(`/api/admin/reports/${id}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminData(); }
export async function handleAdminDeleteFeedback(id) { await request(`/api/admin/feedback/${id}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminData(); }
export async function handleAdminDeleteComment(id) { await request(`/api/admin/comments/${id}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminData(); }
export async function handleAdminUnbanManga(mid) { await request(`/api/admin/banned-mangas/${mid}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminData(); }
export async function handleAdminUnbanUser(uid) { await request(`/api/admin/banned-users/${uid}`, { method: 'DELETE', headers: authHeaders() }); await loadAdminData(); }
export async function handleToggleAdminUser(uid, adm) { await request(`/api/admin/users/${uid}/admin`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isAdmin: adm }) }); await loadAdminData(); }
export async function loadAdminSourceMangas(id, name) {
  els.adminSourceMangasTitle.textContent = name; els.adminRemoteSourceModal.classList.remove('hidden'); updateModalBodyLock();
  els.adminSourceMangasGrid.innerHTML = 'Loading...';
  const d = await request(`/api/admin/sources/${id}/mangas`);
  els.adminSourceMangasGrid.innerHTML = (d.mangas || []).map(m => `<article class="card card-compact" data-action="open-details" data-manga-id="${m.id}"><img class="card-cover" src="${coverSrc(m.coverUrl)}" /><h4>${m.title}</h4></article>`).join('') || 'No manga.';
}
export async function loadAdminRemoteSourceMangas(id, name) {
  els.adminSourceMangasTitle.textContent = 'Remote: ' + name; els.adminRemoteSourceModal.classList.remove('hidden'); updateModalBodyLock();
  els.adminSourceMangasGrid.innerHTML = 'Searching...';
  const d = await request(`/api/admin/sources/${id}/remote-search`);
  els.adminSourceMangasGrid.innerHTML = (d.mangas || []).map(m => `<article class="card card-compact"><h4>${m.title}</h4></article>`).join('') || 'No results.';
}
