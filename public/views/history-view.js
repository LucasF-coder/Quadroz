import { state, els } from '../state.js';
import { request, authHeaders } from '../services/request.js';
import { 
  formatStatusLabel, formatLanguageLabel, formatDateTime, coverSrc 
} from '../utils/format.js';
import { emptyHtml, observeLazyImages, showToast } from '../utils/dom.js';

export function renderHistoryItems(history, helpers, fallbackCover) {
  const list = Array.isArray(history) ? history : [];
  if (list.length === 0) {
    return helpers.emptyHtml('Seu histórico de leitura ainda está vazio.');
  }

  return list
    .map(
      (item) => `
      <article class="history-item">
        <img
          class="history-cover lazy-image"
          src="${fallbackCover}"
          data-src="${helpers.coverSrc(item.coverUrl)}"
          alt="Capa de ${helpers.escapeHtml(item.title)}"
          loading="lazy"
          decoding="async"
          data-action="history-open-details"
          data-manga-id="${item.mangaId}"
        />
        <button class="history-content" data-action="history-open-reader" data-history-id="${item.id}">
          <h3 class="history-title">${helpers.escapeHtml(item.title)}</h3>
          <p class="history-meta">${helpers.escapeHtml(item.author || 'Autor desconhecido')} • ${helpers.formatStatusLabel(
            item.publicationStatus
          )} • ${helpers.formatLanguageLabel(item.sourceLanguage || item.sourceLang)}</p>
          <p class="history-meta">Fonte ${helpers.escapeHtml(item.sourceName || 'Desconhecida')}</p>
          <p class="history-meta">Capítulo ${helpers.escapeHtml(String(item.chapterNumber))} • Página ${item.pageIndex}</p>
          <p class="history-meta">Acessado em ${helpers.escapeHtml(helpers.formatDateTime(item.updatedAt))}</p>
        </button>
        <button class="btn btn-danger history-remove-btn" data-action="history-remove-item" data-history-id="${item.id}">
          Remover
        </button>
      </article>
    `
    )
    .join('');
}

export async function loadHistory(options = {}) {
  const data = await request('/api/history', {
    headers: authHeaders(false)
  });

  state.history = data.history || [];
  if (!options.skipRender) {
    renderHistory();
  }
}

export function renderHistory() {
  if (els.historyClearAllBtn) {
    els.historyClearAllBtn.classList.toggle('hidden', !Array.isArray(state.history) || state.history.length === 0);
  }

  const FALLBACK_COVER = '../placeholder-cover.svg'; // local fallback
  
  els.historyList.innerHTML = renderHistoryItems(
    state.history,
    {
      emptyHtml,
      coverSrc,
      escapeHtml: (str) => str, // Simple escape if not imported
      formatStatusLabel,
      formatLanguageLabel,
      formatDateTime
    },
    FALLBACK_COVER
  );

  observeLazyImages(els.historyList);
}

export async function handleRemoveHistoryItem(historyId) {
  const targetId = Number(historyId);
  if (!Number.isInteger(targetId)) return;

  try {
    await request(`/api/history/${targetId}`, {
      method: 'DELETE',
      headers: authHeaders(false)
    });
    state.history = state.history.filter((item) => Number(item.id) !== targetId);
    renderHistory();
    showToast('Item removido do histórico.');
  } catch (error) {
    showToast(error.message);
  }
}

export async function handleClearAllHistory(options = {}) {
  const { showConfirmDialog } = options;
  const confirmed = showConfirmDialog ? await showConfirmDialog({
    title: 'Limpar histórico',
    message: 'Isso vai apagar todo o histórico de leitura. Deseja continuar?',
    confirmText: 'Limpar tudo',
    cancelText: 'Cancelar',
    danger: true
  }) : confirm('Limpar todo o histórico?');
  
  if (!confirmed) return;

  try {
    await request('/api/history', {
      method: 'DELETE',
      headers: authHeaders(false)
    });
    state.history = [];
    renderHistory();
    showToast('Histórico limpo com sucesso.');
  } catch (error) {
    showToast(error.message);
  }
}

export function upsertLocalHistoryEntry(entry, readerState = {}) {
  if (!entry || !entry.chapterId || !entry.mangaId) return;

  const normalized = {
    id: entry.id || entry.mangaId,
    mangaId: Number(entry.mangaId),
    chapterId: String(entry.chapterId),
    chapterNumber: Number(entry.chapterNumber) || 1,
    pageIndex: Number(entry.pageIndex) || 1,
    updatedAt: entry.updatedAt || new Date().toISOString(),
    title: entry.title || readerState.title || 'Mangá',
    coverUrl: entry.coverUrl || readerState.coverUrl || '',
    author: entry.author || readerState.author || 'Autor desconhecido',
    sourceId: String(entry.sourceId || readerState.sourceId || '').trim(),
    sourceName: String(entry.sourceName || readerState.sourceName || '').trim(),
    sourceLanguage: entry.sourceLanguage || entry.sourceLang || readerState.sourceLanguage || readerState.sourceLang || '',
    sourceLang: entry.sourceLanguage || entry.sourceLang || readerState.sourceLanguage || readerState.sourceLang || '',
    publicationStatus: entry.publicationStatus || readerState.publicationStatus || 'unknown'
  };

  const existingIndex = state.history.findIndex((item) => Number(item.mangaId) === Number(normalized.mangaId));

  if (existingIndex >= 0) {
    const previous = state.history[existingIndex];
    const next = {
      ...previous,
      ...normalized,
      id: previous?.id || normalized.id
    };
    state.history.splice(existingIndex, 1);
    state.history.unshift(next);
  } else {
    state.history.unshift(normalized);
  }

  state.history.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  if (state.history.length > 250) {
    state.history = state.history.slice(0, 250);
  }

  renderHistory();
}

let historySyncTimer = null;

export function queueSaveReadingHistory(readerState, currentChapter) {
  clearTimeout(historySyncTimer);
  historySyncTimer = setTimeout(async () => {
    await saveCurrentReadingHistory(readerState, currentChapter);
  }, 280);
}

export async function saveCurrentReadingHistory(readerState, chapter) {
  if (!readerState.mangaId || !readerState.currentChapterId || !chapter) return;

  try {
    const data = await request('/api/history', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        mangaId: readerState.mangaId,
        chapterId: readerState.currentChapterId,
        chapterNumber: Number(chapter.chapterNumber) || Number(chapter.number) || 1,
        pageIndex: Math.max(1, Number(readerState.currentPage) || 1),
        sourceId: readerState.sourceId || chapter.sourceId || '',
        sourceName: readerState.sourceName || chapter.sourceName || '',
        sourceLanguage: readerState.sourceLanguage || chapter.sourceLanguage || chapter.language || readerState.sourceLang || ''
      })
    });

    upsertLocalHistoryEntry({
      ...data.history,
      title: readerState.title,
      coverUrl: readerState.coverUrl,
      author: readerState.author,
      sourceId: readerState.sourceId || chapter.sourceId || '',
      sourceName: readerState.sourceName || chapter.sourceName || '',
      sourceLanguage: readerState.sourceLanguage || chapter.sourceLanguage || chapter.language || readerState.sourceLang,
      sourceLang: readerState.sourceLang,
      publicationStatus: readerState.publicationStatus
    }, readerState);
  } catch {
    // Fail silently
  }
}
