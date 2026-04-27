import { 
  state, els, assetPath, FALLBACK_COVER, ASSET_VERSION, 
  UI_STATE_STORAGE_KEY, LEGACY_UI_STATE_STORAGE_KEY, 
  TOKEN_STORAGE_KEY, SESSION_TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY,
  getDefaultLibraryAdvancedFilters
} from './state.js';

import { formatDateTime, normalizeSearchQuery, normalizeUiProfileLanguage, coverSrc } from './utils/format.js';
import { setModalVisibility, showToast, updateModalBodyLock, clearReaderImageObserver, initLazyLoader, updateDiscoverLoadMoreVisibility } from './utils/dom.js';
import { debounceWithTimer } from './utils/helpers.js';
import { request, authHeaders, initRequestCache } from './services/request.js';
import { setAuth, logout, renderAuthState, setDetailsTabVisible, setReaderTabVisible } from './services/auth.js';

let discoverObserver = null;
let requestCache = null;
let viewModules = null;
let dialogPromiseResolver = null;
let discoverLoadRequestVersion = 0;
let categoryModalState = null;

// --- MODULE LOADING ---

async function ensureBaseModulesLoaded() {
  if (!requestCache) {
    const { createRequestCache } = await import(assetPath('/services/request-cache.js'));
    requestCache = createRequestCache({ defaultTtlMs: 15000, maxEntries: 400 });
    initRequestCache(requestCache);
  }
  const { createLazyImageLoader } = await import(assetPath('/hooks/useLazyImage.js'));
  initLazyLoader(createLazyImageLoader({ rootMargin: '450px 0px', threshold: 0.01 }));
}

async function ensureViewModulesLoaded() {
  if (viewModules) return viewModules;
  const modules = await Promise.all([
    import(assetPath('/views/discover-view.js')), import(assetPath('/views/library-view.js')),
    import(assetPath('/views/history-view.js')), import(assetPath('/views/ranking-view.js')),
    import(assetPath('/views/details-view.js')), import(assetPath('/views/reader-view.js')),
    import(assetPath('/views/settings-view.js')), import(assetPath('/views/admin-view.js'))
  ]);
  viewModules = {
    discoverView: modules[0], libraryView: modules[1], historyView: modules[2], rankingView: modules[3],
    detailsView: modules[4], readerView: modules[5], settingsView: modules[6], adminView: modules[7]
  };
  viewModules.adminView.bindAdminActions();
  return viewModules;
}

// --- CORE ---

function renderViews() {
  const views = { discover: els.discoverView, library: els.libraryView, history: els.historyView, ranking: els.rankingView, settings: els.settingsView, admin: els.adminView, details: els.detailsView, reader: els.readerView };
  Object.entries(views).forEach(([name, el]) => { if (el) el.classList.toggle('hidden', state.view !== name); });
  setDetailsTabVisible(state.view === 'details');
  setReaderTabVisible(state.view === 'reader');
  if (state.view !== 'reader') { state.reader.commentsOpen = false; els.readerCommentsPanel?.classList.add('hidden'); clearReaderImageObserver(); }
  updateModalBodyLock();
  document.querySelectorAll('#mainTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === state.view));
  updateDiscoverLoadMoreVisibility();
}

function persistUiState() {
  if (!state.token) return;
  const p = { view: state.view, previousView: state.previousView, discover: state.discover, libraryFilters: state.libraryFilters, rankingFilters: state.rankingFilters, details: { mangaId: state.details.mangaId, selectedSourceId: state.details.selectedSourceId, selectedLanguage: state.details.selectedLanguage }, admin: { activeTab: state.admin.activeTab }, viewScroll: state.viewScroll };
  try { sessionStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(p)); } catch {}
}

function restoreUiState() {
  try {
    const raw = sessionStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    state.previousView = p.previousView || 'discover';
    if (p.discover) state.discover = { ...state.discover, ...p.discover };
    if (p.libraryFilters) state.libraryFilters = { ...state.libraryFilters, ...p.libraryFilters };
    if (p.rankingFilters) state.rankingFilters = { ...state.rankingFilters, ...p.rankingFilters };
    if (p.details) state.details = { ...state.details, ...p.details };
    if (p.admin) state.admin.activeTab = p.admin.activeTab;
    state.view = p.view || 'discover';
  } catch {}
}

function goToView(next, o = {}) {
  const target = next?.trim(); if (!target || target === state.view) return;
  if (o.rememberCurrent !== false && state.view in state.viewScroll) state.viewScroll[state.view] = window.scrollY;
  state.view = target; renderViews();
  if (target !== 'reader') window.scrollTo({ top: state.viewScroll[target] || 0, behavior: 'auto' });
  persistUiState();
}

// --- GLOBAL DIALOGS ---

function openAppDialog(options = {}) {
  if (!els.appDialogModal) return Promise.resolve(null);
  els.appDialogTitle.textContent = options.title || 'Confirmação';
  els.appDialogMessage.textContent = options.message || '';
  els.appDialogConfirmBtn.textContent = options.confirmText || 'Confirmar';
  els.appDialogCancelBtn.textContent = options.cancelText || 'Cancelar';
  const mode = options.mode || 'confirm';
  els.appDialogInput.classList.toggle('hidden', mode !== 'prompt');
  els.appDialogSelect.classList.toggle('hidden', mode !== 'select');
  if (mode === 'select' && options.selectOptions) {
    els.appDialogSelect.innerHTML = options.selectOptions.map(v => `<option value="${v}" ${v === options.defaultValue ? 'selected' : ''}>${options.selectValueToLabel ? options.selectValueToLabel(v) : v}</option>`).join('');
  }
  els.appDialogModal.classList.remove('hidden'); updateModalBodyLock();
  return new Promise((resolve) => {
    dialogPromiseResolver = resolve;
    els.appDialogCancelBtn.onclick = () => { els.appDialogModal.classList.add('hidden'); updateModalBodyLock(); resolve(null); };
    els.appDialogConfirmBtn.onclick = () => {
      els.appDialogModal.classList.add('hidden'); updateModalBodyLock();
      if (mode === 'select') return resolve(els.appDialogSelect.value);
      if (mode === 'prompt') return resolve(els.appDialogInput.value);
      resolve(true);
    };
  });
}
async function showConfirmDialog(o) { return await openAppDialog({ mode: 'confirm', ...o }) === true; }
async function showSelectDialog(o) { return await openAppDialog({ mode: 'select', ...o }); }
async function showPromptDialog(o) { return await openAppDialog({ mode: 'prompt', ...o }); }

// --- AUTHENTICATION ---

async function loadMe() {
  try {
    const d = await request('/api/auth/me', { headers: authHeaders(false) });
    state.user = { ...d.user, isAdmin: !!d.user?.isAdmin, isOwner: !!d.user?.isOwner };
  } catch { state.user = null; }
}

async function afterAuthLoad() {
  restoreUiState();
  await loadMe();
  renderAuthState();
  setReaderTabVisible(false);
  setDetailsTabVisible(false);
  if (state.view === 'admin' && !state.user?.isAdmin) state.view = 'discover';
  renderViews();
  try {
    const b = await request('/api/bootstrap', { headers: authHeaders(false) });
    if (b.genres) state.genres = b.genres;
    if (b.categories) state.categories = b.categories;
    if (b.library) state.library = b.library;
    if (b.history) state.history = b.history;
    if (b.ranking) state.ranking = b.ranking;
  } catch {
    await Promise.all([viewModules.settingsView.loadCategories(), loadLibrary(), loadHistory(), loadRanking(), viewModules.settingsView.loadSettings()]);
  }
  await loadMangas();
  await loadRecommendedMangas({ random: true });
  if (state.view === 'details' && state.details.mangaId) await openDetails(state.details.mangaId, true);
  if (state.user?.isAdmin) await viewModules.adminView.loadAdminData();
  renderAll();
}

async function handleLogin(e) { 
  e.preventDefault(); const f = new FormData(e.target); 
  try {
    const d = await request('/api/auth/login', { method: 'POST', headers: authHeaders(false), body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) }); 
    setAuth(d.token, d.user, { persistence: f.get('remember') === 'on' ? 'local' : 'session' }); 
    await afterAuthLoad(); e.target.reset(); showToast('Bem-vindo!'); 
  } catch (err) { showToast(err.message); }
}

async function handleRegister(e) { 
  e.preventDefault(); const f = new FormData(e.target); 
  try {
    const d = await request('/api/auth/register', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ 
        username: f.get('username'), email: f.get('email'), 
        password: f.get('password'), preferredLanguage: f.get('preferredLanguage') 
      }) 
    }); 
    setAuth(d.token, d.user); await afterAuthLoad(); e.target.reset(); showToast('Conta criada com sucesso!'); 
  } catch (err) { showToast(err.message); }
}

// --- DATA FETCHING ---

async function loadRecommendedMangas(o = {}) {
  try {
    const d = await request(`/api/mangas/recommended?limit=12&random=${o.random ? 1 : 0}`, { headers: authHeaders(false) });
    state.recommendations = d.mangas || [];
    viewModules.discoverView.renderRecommendations();
  } catch {}
}

async function loadLibrary() { const d = await request('/api/library', { headers: authHeaders(false) }); state.library = d.library || []; viewModules.libraryView.renderLibrary(); }
async function loadHistory() { const d = await request('/api/history', { headers: authHeaders(false) }); state.history = d.history || []; viewModules.historyView.renderHistory(); }
async function loadRanking() { const d = await request('/api/ranking', { headers: authHeaders(false) }); state.ranking = d.ranking || []; viewModules.rankingView.renderRanking(); }

async function loadMangas(o = {}) {
  if (!o.append) viewModules.discoverView.resetDiscoverPagination();
  const v = ++discoverLoadRequestVersion;
  state.discover.isLoadingMore = true; updateDiscoverLoadMoreVisibility();
  try {
    const adv = state.discover.advanced || {};
    const p = new URLSearchParams({ 
      search: state.discover.search || '', 
      limit: String(state.discover.limit), 
      cursor: String(o.append ? state.discover.cursor : 0), 
      language: state.settings.preferredLanguage || 'pt-br',
      includeGenres: (adv.includeGenres || []).join(','),
      excludeGenres: (adv.excludeGenres || []).join(','),
      sources: (adv.sources || []).join(','),
      strictInclude: adv.strictInclude ? '1' : '0',
      strictExclude: adv.strictExclude ? '1' : '0'
    });
    const d = await request(`/api/mangas?${p.toString()}`, { headers: authHeaders(false) });
    if (v !== discoverLoadRequestVersion) return;
    
    const newMangas = d.mangas || [];
    state.mangas = o.append ? [...state.mangas, ...newMangas] : newMangas;
    state.discover.hasMore = !!d.pagination?.hasMore; state.discover.cursor = d.pagination?.nextCursor || 0;
    viewModules.discoverView.renderMangas();
  } finally { if (v === discoverLoadRequestVersion) { state.discover.isLoadingMore = false; updateDiscoverLoadMoreVisibility(); } }
}

// --- ACTIONS ---

async function openDetails(mid, resume = false) {
  await viewModules.detailsView.openDetails(mid, resume, {
    goToView, setDetailsTabVisible, persistUiState,
    renderDetails: viewModules.detailsView.renderDetails,
    loadDetailsChapters: async (id, chap, pg) => {
      const p = new URLSearchParams({ lang: state.details.selectedLanguage || 'pt-br', sourceId: state.details.selectedSourceId || '' });
      const d = await request(`/api/mangas/${id}/chapters?${p.toString()}`, { headers: authHeaders(false) });
      state.details.chapters = d.chapters || []; state.details.sources = d.sources || [];
      state.details.availableLanguages = d.availableLanguages || [];
      if (!state.details.selectedSourceId && d.selectedSourceId) state.details.selectedSourceId = d.selectedSourceId;
      state.details.selectedChapterId = chap || d.chapters?.[0]?.id || '';
      state.details.selectedPage = pg || 1;
    }
  });
  if (state.user?.isAdmin) els.detailsAdminToolsBtn?.classList.remove('hidden');
}

async function handleFavoriteToggle(mid) {
  try {
    const r = await request(`/api/favorites/${mid}`, { method: 'POST', headers: authHeaders(false) });
    viewModules.detailsView.applyMangaStatePatch(mid, { isFavorited: !!r.isFavorited, favoriteCount: r.favoriteCount });
    viewModules.discoverView.renderMangas(); viewModules.detailsView.renderDetails();
  } catch (err) { showToast(err.message); }
}

async function handleAddLibrary(mid) {
  try {
    const isDet = Number(state.details.mangaId) === Number(mid);
    const body = isDet ? JSON.stringify({ sourceId: state.details.selectedSourceId, sourceName: state.details.selectedSourceName, sourceLanguage: state.details.selectedLanguage }) : undefined;
    await request(`/api/library/${mid}`, { method: 'POST', headers: authHeaders(!!body), body });
    viewModules.detailsView.applyMangaStatePatch(mid, { inLibrary: true });
    await loadLibrary(); viewModules.discoverView.renderMangas(); viewModules.detailsView.renderDetails(); showToast('Adicionado.');
  } catch (err) { showToast(err.message); }
}

async function handleRemoveLibrary(mid) {
  try {
    await request(`/api/library/${mid}`, { method: 'DELETE', headers: authHeaders(false) });
    viewModules.detailsView.applyMangaStatePatch(mid, { inLibrary: false });
    await loadLibrary(); viewModules.discoverView.renderMangas(); viewModules.detailsView.renderDetails(); showToast('Removido.');
  } catch (err) { showToast(err.message); }
}

async function openReaderFromDetails() {
  const { manga, chapters, selectedChapterId, selectedPage, selectedSourceId, selectedSourceName, selectedLanguage } = state.details;
  console.log('[openReader] Iniciando...', { mangaId: manga?.id, selectedChapterId, selectedPage });
  
  if (!manga) {
    console.error('[openReader] Falha: Mangá não carregado no estado.');
    return showToast('Erro: Detalhes do mangá não carregados.');
  }
  
  if (!selectedChapterId) {
    console.error('[openReader] Falha: Nenhum capítulo selecionado.');
    return showToast('Selecione um capítulo antes de ler.');
  }

  try {
    console.log('[openReader] Chamando viewModules.readerView.openReader');
    await viewModules.readerView.openReader({
      mangaId: manga.id, title: manga.title, coverUrl: manga.coverUrl, author: manga.author,
      publicationStatus: manga.publicationStatus, sourceId: selectedSourceId, sourceName: selectedSourceName,
      sourceLanguage: selectedLanguage, sourceLang: manga.sourceLang, chapters, chapterId: selectedChapterId, page: selectedPage || 1
    }, { 
      goToView, 
      persistUiState, 
      onPageChange: () => viewModules.historyView.queueSaveReadingHistory(state.reader, viewModules.readerView.getCurrentReaderChapter()) 
    });
    console.log('[openReader] Sucesso!');
  } catch (err) {
    console.error('[openReader] Erro capturado:', err);
    showToast(`Erro ao abrir leitor: ${err.message}`);
  }
}

async function handleReportManga(mangaId) {
  const reasons = [{ value: 'source_mismatch', label: 'Capítulos errados' }, { value: 'bad_quality', label: 'Qualidade ruim' }, { value: 'missing_chapters', label: 'Faltam capítulos' }, { value: 'other', label: 'Outro' }];
  const reason = await showSelectDialog({ title: 'Reportar', message: 'Motivo:', selectOptions: reasons.map(r=>r.value), selectValueToLabel: v=>reasons.find(r=>r.value===v).label });
  if (!reason) return;
  let details = ''; if (reason === 'other') { details = await showPromptDialog({ title: 'Detalhes', required: true }); if (!details) return; }
  try {
    await request('/api/reports', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ targetType: 'manga', targetId: String(mangaId), reason, details }) });
    showToast('Reportado.');
  } catch (err) { showToast(err.message); }
}

async function openMangaAdminTools() {
  const mid = state.details.mangaId;
  if (els.mangaAdminToolsSubtitle) els.mangaAdminToolsSubtitle.textContent = `Mangá ID: ${mid}`;
  
  els.mangaAdminToolsModal.classList.remove('hidden'); 
  updateModalBodyLock();
  
  const list = document.getElementById('mangaAdminSourcesList'); 
  list.innerHTML = '<div class="loading-spinner"></div> Carregando fontes...';
  
  try {
    const d = await request(`/api/admin/mangas/${mid}/sources`, { headers: authHeaders() });
    list.innerHTML = (d.sources || []).map(s => `
      <div class="settings-cat-row">
        <p>${s.sourceName} (${s.lang}) ${s.isRemoved ? '🚫' : '✅'}</p>
        <button class="btn" data-action="admin-toggle-manga-source" data-source-id="${s.sourceId}" data-removed="${s.isRemoved?0:1}">
          ${s.isRemoved?'Ativar':'Apagar'}
        </button>
      </div>
    `).join('') || 'Sem fontes vinculadas.';
  } catch (err) {
    list.innerHTML = `<p class="color-danger">Erro ao carregar fontes: ${err.message}</p>`;
  }
}

async function openMangaCategoriesModal(mangaId) {
  try {
    const data = await request(`/api/mangas/${mangaId}/categories`, { headers: authHeaders(false) });
    categoryModalState = { mangaId, selectedIds: new Set(data.categoryIds || []) };
    els.mangaCategoriesList.innerHTML = state.categories.map(c => `<label class="category-item"><input type="checkbox" value="${c.id}" ${categoryModalState.selectedIds.has(c.id) ? 'checked' : ''} /><span>${c.name}</span></label>`).join('') || '<p>Crie categorias nas configurações.</p>';
    els.mangaCategoriesModal.classList.remove('hidden'); updateModalBodyLock();
  } catch (err) { showToast(err.message); }
}

// --- EVENTS ---

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.registerForm.addEventListener('submit', handleRegister);
  els.logoutBtn.addEventListener('click', () => { logout(); renderAuthState(); goToView('discover'); });

  els.mainTabs.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-view]'); if (!tab) return;
    const v = tab.dataset.view; goToView(v);
    if (v === 'admin' && state.user?.isAdmin) await viewModules.adminView.loadAdminData();
    if (v === 'ranking') await loadRanking();
    if (v === 'history') await loadHistory();
    if (v === 'settings') await viewModules.settingsView.loadSettings();
  });

  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const action = el.dataset.action; const mid = el.dataset.mangaId || state.details.mangaId;

    switch(action) {
      case 'open-details': await openDetails(el.dataset.mangaId); break;
      case 'details-back': goToView(state.previousView || 'discover'); break;
      case 'toggle-favorite': await handleFavoriteToggle(mid); break;
      case 'add-library': await handleAddLibrary(mid); break;
      case 'remove-library': await handleRemoveLibrary(mid); break;
      case 'manage-categories': await openMangaCategoriesModal(mid); break;
      case 'report-manga': await handleReportManga(mid); break;
      case 'open-manga-config':
        if (state.user?.isAdmin) await openMangaAdminTools();
        else showToast('Opções avançadas disponíveis apenas para administradores.');
        break;
      case 'open-manga-admin-tools': await openMangaAdminTools(); break;
      case 'close-manga-admin-tools': els.mangaAdminToolsModal.classList.add('hidden'); updateModalBodyLock(); break;
      case 'discover-advanced-filters':
      case 'library-advanced-filters': await viewModules.libraryView.openAdvancedFiltersModal(action.startsWith('discover') ? 'discover' : 'library'); break;
      case 'discover-refresh-recommendations': await loadRecommendedMangas({ random: true }); showToast('Novas recomendações carregadas.'); break;
      case 'library-filters-close':
      case 'library-filters-cancel': els.libraryFiltersModal.classList.add('hidden'); updateModalBodyLock(); break;
      case 'library-filters-apply': viewModules.libraryView.applyAdvancedFilters(); break;
      case 'library-filters-clear': viewModules.libraryView.clearAdvancedFilters(); break;
      case 'settings-add-category': await viewModules.settingsView.handleSettingsAddCategory({ loadMangas, loadLibrary }); break;
      case 'send-feedback': await viewModules.settingsView.handleSendFeedback(); break;
      case 'settings-save-language': await viewModules.settingsView.handleSavePreferredLanguage({ loadMangas, loadRecommendedMangas: () => {}, resetDiscoverPagination: viewModules.discoverView.resetDiscoverPagination }); break;
      case 'open-reader-from-details': await openReaderFromDetails(); break;
      case 'reader-back': goToView(state.previousView || 'discover'); break;
      case 'reader-toggle-comments': state.reader.commentsOpen = !state.reader.commentsOpen; viewModules.readerView.renderReaderOverlay(); break;
      case 'reader-toggle-bookmark': await viewModules.readerView.toggleCurrentBookmark(); break;
      case 'reader-save-progress': await viewModules.historyView.saveCurrentReadingHistory(state.reader, viewModules.readerView.getCurrentReaderChapter()); showToast('Salvo.'); break;
      case 'admin-switch-tab': viewModules.adminView.switchAdminTab(el.dataset.adminTab); break;
      case 'admin-run-sync': await viewModules.adminView.handleAdminRunSync(); break;
      case 'admin-refresh-sync-status': await viewModules.adminView.handleAdminRefreshSyncStatus(); break;
      case 'admin-delete-report': await viewModules.adminView.handleAdminDeleteReport(el.dataset.reportId); break;
      case 'admin-ban-manga-from-report': await viewModules.adminView.handleAdminBanMangaFromReport(el.dataset.reportId, el.dataset.mangaId); break;
      case 'admin-ban-user-from-report': await viewModules.adminView.handleAdminBanUserFromReport(el.dataset.reportId, el.dataset.userId); break;
      case 'admin-delete-comment-from-report': await viewModules.adminView.handleAdminDeleteCommentFromReport(el.dataset.reportId, el.dataset.commentId); break;
      case 'admin-unban-manga': await viewModules.adminView.handleAdminUnbanManga(el.dataset.mangaId); break;
      case 'admin-toggle-source': await viewModules.adminView.handleAdminToggleSource(el.dataset.sourceId, el.dataset.sourceName, el.dataset.lang, el.dataset.nextState, el.dataset.provider); break;
      case 'admin-delete-source': await viewModules.adminView.handleAdminDeleteSource(el.dataset.sourceId); break;
      case 'admin-view-source-mangas': await viewModules.adminView.loadAdminSourceMangas(el.dataset.sourceId, el.dataset.sourceName); break;
      case 'admin-preview-source': await viewModules.adminView.loadAdminRemoteSourceMangas(el.dataset.sourceId, el.dataset.sourceName); break;
      case 'admin-remote-source-close': els.adminRemoteSourceModal.classList.add('hidden'); updateModalBodyLock(); break;
      case 'admin-delete-feedback': await viewModules.adminView.handleAdminDeleteFeedback(el.dataset.feedbackId); break;
      case 'admin-delete-comment': await viewModules.adminView.handleAdminDeleteComment(el.dataset.commentId); break;
      case 'admin-unban-user': await viewModules.adminView.handleAdminUnbanUser(el.dataset.userId); break;
      case 'toggle-admin-user': await viewModules.adminView.handleToggleAdminUser(el.dataset.userId, el.dataset.nextAdmin === '1'); break;
      case 'admin-ban-manga-now':
        if (await showConfirmDialog({ title: 'Banir', message: 'Banir de vez? Ele sumirá de todos os catálogos e bibliotecas.', danger: true })) {
          try {
            await request(`/api/admin/banned-mangas`, { 
              method: 'POST', 
              headers: authHeaders(), 
              body: JSON.stringify({ mangaId: state.details.mangaId, reason: 'Banimento manual via admin' }) 
            });
            showToast('Mangá banido com sucesso.');
            goToView('discover');
            await loadMangas();
            if (viewModules.adminView) await viewModules.adminView.loadAdminData();
          } catch (err) {
            showToast(`Erro ao banir: ${err.message}`);
          }
        }
        break;
      case 'admin-toggle-manga-source': 
        try {
          await request(`/api/admin/mangas/${state.details.mangaId}/sources/${el.dataset.sourceId}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ removed: el.dataset.removed === '1' }) });
          await openMangaAdminTools();
        } catch (err) { showToast(err.message); }
        break;
      case 'close-manga-categories': els.mangaCategoriesModal.classList.add('hidden'); updateModalBodyLock(); break;
      case 'manga-categories-save':
        if (!categoryModalState) return;
        try {
          await request(`/api/mangas/${categoryModalState.mangaId}/categories`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ categoryIds: Array.from(categoryModalState.selectedIds) }) });
          els.mangaCategoriesModal.classList.add('hidden'); updateModalBodyLock(); showToast('Categorias salvas.'); await loadLibrary();
        } catch (err) { showToast(err.message); }
        break;
    }
  });

  els.mangaSearchBtn.addEventListener('click', () => { state.discover.search = normalizeSearchQuery(els.mangaSearch.value); loadMangas(); });
  els.mangaSearch.addEventListener('keypress', (e) => { if (e.key === 'Enter') { state.discover.search = normalizeSearchQuery(els.mangaSearch.value); loadMangas(); } });
  els.librarySearch.addEventListener('input', (e) => {
    librarySearchTimer = debounceWithTimer(librarySearchTimer, 300, () => { state.libraryFilters.search = normalizeSearchQuery(e.target.value); viewModules.libraryView.renderLibrary(); });
  });

  els.rankingGenreFilter.addEventListener('change', (e) => { state.rankingFilters.category = e.target.value; loadRanking(); });
  els.rankingStatusFilter.addEventListener('change', (e) => { state.rankingFilters.status = e.target.value; loadRanking(); });
  els.rankingLanguageFilter.addEventListener('change', (e) => { state.rankingFilters.language = e.target.value; loadRanking(); });

  if (els.discoverLoadMore) {
    discoverObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && state.discover.hasMore && !state.discover.isLoadingMore) loadMangas({ append: true });
    }, { rootMargin: '300px' });
    discoverObserver.observe(els.discoverLoadMore);
  }

  els.readerTapCenter?.addEventListener('click', () => viewModules.readerView.toggleReaderOverlay());
  els.readerTapLeft?.addEventListener('click', () => viewModules.readerView.goToPreviousPage());
  els.readerTapRight?.addEventListener('click', () => viewModules.readerView.goToNextPage());

  // Encaminha double click das zonas para o zoom no modo paged
  const forwardDblClick = (e) => {
    if (state.reader.mode === 'paged') {
      viewModules.readerView.handleReaderDoubleTap?.(e);
    }
  };
  els.readerTapCenter?.addEventListener('dblclick', forwardDblClick);
  els.readerTapLeft?.addEventListener('dblclick', forwardDblClick);
  els.readerTapRight?.addEventListener('dblclick', forwardDblClick);

  els.readerModeSelect.addEventListener('change', (e) => {
    state.reader.mode = e.target.value;
    viewModules.readerView.renderReaderContent();
  });
}

function bindDetailsSelects() {
  els.detailsLanguageFilter.addEventListener('change', async (e) => { state.details.selectedLanguage = e.target.value; state.details.selectedSourceId = ''; await openDetails(state.details.mangaId); });
  els.detailsSourceSelect.addEventListener('change', async (e) => { state.details.selectedSourceId = e.target.value; await openDetails(state.details.mangaId); });
  els.detailsChapterSelect.addEventListener('change', e => { state.details.selectedChapterId = e.target.value; viewModules.detailsView.renderDetails(); });
  els.detailsPageSelect.addEventListener('change', e => { state.details.selectedPage = Number(e.target.value); viewModules.detailsView.renderDetails(); });
}

function bindReaderSelects() {
  els.readerChapterSelect.addEventListener('change', async (e) => {
    await viewModules.readerView.changeReaderChapter(e.target.value, 1);
  });
  els.readerPageSelect.addEventListener('change', (e) => {
    state.reader.currentPage = Number(e.target.value);
    viewModules.readerView.renderReaderContent();
    viewModules.readerView.renderReaderOverlay();
  });
}

function renderAll() {
  viewModules.discoverView.renderMangas(); viewModules.libraryView.renderLibrary(); viewModules.historyView.renderHistory();
  viewModules.rankingView.renderRanking(); viewModules.settingsView.renderSettings(); viewModules.adminView.renderAdmin();
  viewModules.detailsView.renderDetails(); renderViews();
}

async function init() {
  await ensureBaseModulesLoaded(); await ensureViewModulesLoaded();
  restoreUiState(); bindEvents(); bindDetailsSelects(); bindReaderSelects();
  renderViews();
  if (state.token) await afterAuthLoad(); else { renderAuthState(); loadMangas(); }
}

init();
