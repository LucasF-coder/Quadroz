import { state, els } from '../state.js';
import { request, authHeaders } from '../services/request.js';
import { formatDateTime, normalizeUiProfileLanguage } from '../utils/format.js';
import { emptyHtml, showToast } from '../utils/dom.js';

export function renderSettingsStats() {
  const stats = state.settings.stats || {};

  const cards = [
    { label: 'Na biblioteca', value: stats.libraryCount || 0 },
    { label: 'Favoritos', value: stats.favoriteCount || 0 },
    { label: 'Capítulos lidos', value: stats.chaptersRead || 0 },
    { label: 'Páginas lidas', value: stats.pagesRead || 0 },
    { label: 'Completos na biblioteca', value: stats.completedInLibrary || 0 },
    { label: 'Em lançamento na biblioteca', value: stats.ongoingInLibrary || 0 },
    { label: 'Categorias', value: stats.categoriesCount || 0 }
  ];

  els.settingsStats.innerHTML = cards
    .map(
      (item) => `
      <div class="stat-card">
        <p class="stat-value">${item.value}</p>
        <p class="stat-label">${item.label}</p>
      </div>
    `
    )
    .join('');
}

export function renderSettings() {
  const preferred = normalizeUiProfileLanguage(state.settings.preferredLanguage, 'pt-br');
  state.settings.preferredLanguage = preferred;
  els.settingsLanguageSelect.value = preferred;
  renderSettingsStats();
  renderSettingsCategories();
  renderMyFeedback();
  renderCommentsHistory();
}

export function renderSettingsCategories() {
  if (state.categories.length === 0) {
    els.settingsCategoriesList.innerHTML = emptyHtml('Nenhuma categoria cadastrada.');
    return;
  }

  els.settingsCategoriesList.innerHTML = state.categories
    .map(
      (category) => `
      <div class="settings-cat-row">
        <input type="text" value="${category.name}" data-role="settings-category-name" data-category-id="${category.id}" maxlength="40" />
        <button class="btn" data-action="settings-save-category" data-category-id="${category.id}">Salvar</button>
        <button class="btn btn-danger" data-action="settings-delete-category" data-category-id="${category.id}">Excluir</button>
      </div>
    `
    )
    .join('');
}

export function renderMyFeedback() {
  if (!Array.isArray(state.myFeedback) || state.myFeedback.length === 0) {
    els.myFeedbackList.innerHTML = emptyHtml('Nenhum feedback enviado ainda.');
    return;
  }

  els.myFeedbackList.innerHTML = state.myFeedback
    .map(
      (item) => `
      <div class="settings-cat-row settings-list-col">
        <p><strong>${String(item.category || 'general').toUpperCase()}</strong> - ${formatDateTime(item.createdAt)} - Status: ${
          item.status || 'new'
        }</p>
        <p>${item.message}</p>
        ${item.adminNotes ? `<p><strong>Resposta admin:</strong> ${item.adminNotes}</p>` : ''}
      </div>
    `
    )
    .join('');
}

export function renderCommentsHistory() {
  if (!Array.isArray(state.commentsHistory) || state.commentsHistory.length === 0) {
    els.settingsCommentsHistoryList.innerHTML = emptyHtml('Você ainda não comentou capítulos.');
    return;
  }

  els.settingsCommentsHistoryList.innerHTML = state.commentsHistory
    .map(
      (comment) => `
      <div class="settings-cat-row settings-list-col">
        <p><strong>${comment.mangaTitle || 'Mangá'}</strong> - Cap. ${comment.chapterId || '-'} - ${
          formatDateTime(comment.createdAt)
        }</p>
        <p>${comment.text}</p>
      </div>
    `
    )
    .join('');
}

export async function loadSettings() {
  const data = await request('/api/settings', {
    headers: authHeaders(false)
  });

  state.settings.preferredLanguage = normalizeUiProfileLanguage(data.preferences?.preferredLanguage, 'pt-br');
  state.settings.nsfwProtection = data.preferences?.nsfwProtection === 0 ? 0 : 1;
  
  if (els.commentLanguageSelect.querySelector(`option[value="${state.settings.preferredLanguage}"]`)) {
    els.commentLanguageSelect.value = state.settings.preferredLanguage;
  }
  if (els.settingsNsfwProtection) {
    els.settingsNsfwProtection.checked = state.settings.nsfwProtection === 1;
  }
  state.settings.stats = data.stats || state.settings.stats;
  renderSettings();
}

export async function loadCommentsHistory() {
  const data = await request('/api/comments/history', {
    headers: authHeaders(false)
  });
  state.commentsHistory = data.comments || [];
  renderCommentsHistory();
}

export async function loadMyFeedback() {
  const data = await request('/api/feedback/my', {
    headers: authHeaders(false)
  });
  state.myFeedback = data.feedback || [];
  renderMyFeedback();
}

export async function loadCategories() {
  const data = await request('/api/categories', {
    headers: authHeaders(false)
  });
  state.categories = data.categories || [];
  renderSettingsCategories();
}

export async function handleSettingsAddCategory(options = {}) {
  const name = String(els.settingsNewCategoryInput.value || '').trim();
  if (!name) {
    showToast('Digite um nome de categoria.');
    return;
  }

  try {
    await request('/api/categories', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name })
    });

    els.settingsNewCategoryInput.value = '';
    const { loadMangas, loadLibrary, loadRanking } = options;
    await Promise.all([
      loadCategories(),
      loadMangas ? loadMangas() : Promise.resolve(),
      loadLibrary ? loadLibrary() : Promise.resolve(),
      loadRanking ? loadRanking() : Promise.resolve(),
      loadSettings()
    ]);
    showToast('Categoria criada com sucesso.');
  } catch (error) {
    showToast(error.message);
  }
}

export async function handleSettingsSaveCategory(categoryId, inputEl, options = {}) {
  const name = String(inputEl?.value || '').trim();
  if (!name) {
    showToast('Nome da categoria não pode ficar vazio.');
    return;
  }

  try {
    await request(`/api/categories/${categoryId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name })
    });

    const { loadMangas, loadLibrary, loadRanking } = options;
    await Promise.all([
      loadCategories(),
      loadMangas ? loadMangas() : Promise.resolve(),
      loadLibrary ? loadLibrary() : Promise.resolve(),
      loadRanking ? loadRanking() : Promise.resolve(),
      loadSettings()
    ]);
    showToast('Categoria atualizada com sucesso.');
  } catch (error) {
    showToast(error.message);
  }
}

export async function handleSettingsDeleteCategory(categoryId, options = {}) {
  try {
    await request(`/api/categories/${categoryId}`, {
      method: 'DELETE',
      headers: authHeaders(false)
    });

    const { loadMangas, loadLibrary, loadRanking } = options;
    await Promise.all([
      loadCategories(),
      loadMangas ? loadMangas() : Promise.resolve(),
      loadLibrary ? loadLibrary() : Promise.resolve(),
      loadRanking ? loadRanking() : Promise.resolve(),
      loadSettings()
    ]);
    showToast('Categoria removida com sucesso.');
  } catch (error) {
    showToast(error.message);
  }
}

export async function handleSavePreferredLanguage(options = {}) {
  const preferredLanguage = normalizeUiProfileLanguage(els.settingsLanguageSelect.value, 'pt-br');

  try {
    await request('/api/settings/language', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ preferredLanguage })
    });

    state.settings.preferredLanguage = preferredLanguage;
    if (els.commentLanguageSelect.querySelector(`option[value="${preferredLanguage}"]`)) {
      els.commentLanguageSelect.value = preferredLanguage;
    }
    
    const { loadMangas, loadRecommendedMangas, resetDiscoverPagination } = options;
    if (resetDiscoverPagination) resetDiscoverPagination();
    
    await Promise.all([
      loadMangas ? loadMangas() : Promise.resolve(),
      loadRecommendedMangas ? loadRecommendedMangas({ random: true }).catch(() => undefined) : Promise.resolve()
    ]);
    showToast('Idioma atualizado.');
  } catch (error) {
    showToast(error.message);
  }
}

export async function handleSendFeedback() {
  const category = String(els.feedbackCategorySelect.value || 'general');
  const message = String(els.feedbackInput.value || '').trim();

  if (!message) {
    showToast('Digite um feedback antes de enviar.');
    return;
  }

  try {
    await request('/api/feedback', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ category, message })
    });
    els.feedbackInput.value = '';
    await loadMyFeedback();
    showToast('Feedback enviado.');
  } catch (error) {
    showToast(error.message);
  }
}
