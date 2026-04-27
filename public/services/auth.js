import { state, els, TOKEN_STORAGE_KEY, LEGACY_TOKEN_STORAGE_KEY, SESSION_TOKEN_STORAGE_KEY } from '../state.js';

export function setAdminTabVisible(visible) {
  if (els.adminTab) els.adminTab.classList.toggle('hidden', !visible);
}

export function setDetailsTabVisible(visible) {
  if (els.detailsTab) els.detailsTab.classList.toggle('hidden', !visible);
}

export function setReaderTabVisible(visible) {
  if (els.readerTab) els.readerTab.classList.toggle('hidden', !visible);
}

export function renderAuthState() {
  const loggedIn = Boolean(state.token && state.user);

  els.authSection.classList.toggle('hidden', loggedIn);
  els.topbar.classList.toggle('hidden', !loggedIn);
  els.contentSection.classList.toggle('hidden', !loggedIn);

  if (loggedIn) {
    els.userName.textContent = state.user.username;
    setAdminTabVisible(Boolean(state.user?.isAdmin));
  } else {
    setAdminTabVisible(false);
  }
}

export function setAuth(token, user, options = {}) {
  state.token = token || '';
  state.user = user || null;
  state.authPersistence = options.persistence === 'session' ? 'session' : 'local';

  if (state.token) {
    if (state.authPersistence === 'session') {
      sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, state.token);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    } else {
      localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
      localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  }

  renderAuthState();
}

export function logout() {
  setAuth('', null);
  state.library = [];
  state.history = [];
  state.mangas = [];
  state.user = null;
  state.token = '';
  
  sessionStorage.clear(); 
  
  window.location.hash = '';
  window.location.reload(); 
}
