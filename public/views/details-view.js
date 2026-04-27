import { state, els, FALLBACK_COVER } from '../state.js';
import { 
  escapeHtml, formatStatusLabel, formatLanguageLabel, formatCategories, 
  coverSrc, normalizeUiProfileLanguage 
} from '../utils/format.js';
import { 
  observeLazyImages, buildNumberOptions, showToast
} from '../utils/dom.js';
import { request, authHeaders } from '../services/request.js';
import { createTtlCache } from '../utils/helpers.js';

const DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAILS_CACHE_MAX_ENTRIES = 50;
const detailsMangaCache = createTtlCache(DETAILS_CACHE_MAX_ENTRIES, DETAILS_CACHE_TTL_MS);
export { detailsMangaCache };
export const detailsChaptersCache = createTtlCache(DETAILS_CACHE_MAX_ENTRIES, DETAILS_CACHE_TTL_MS);
export const mangaDetailsPrefetching = new Set();

export function findMangaPreviewById(mangaId) {
  const target = Number(mangaId);
  if (!Number.isInteger(target)) return null;

  const discoverMatch = state.mangas.find((item) => Number(item.id) === target);
  if (discoverMatch) return { ...discoverMatch };

  const libraryMatch = state.library.find((item) => Number(item.mangaId) === target);
  if (libraryMatch) {
    return {
      id: libraryMatch.mangaId,
      title: libraryMatch.title,
      description: libraryMatch.description,
      author: libraryMatch.author,
      coverUrl: libraryMatch.coverUrl,
      totalChapters: libraryMatch.totalChapters,
      favoriteCount: libraryMatch.favoriteCount,
      isFavorited: Boolean(libraryMatch.isFavorited),
      inLibrary: true,
      publicationStatus: libraryMatch.publicationStatus,
      sourceLang: libraryMatch.sourceLanguage || libraryMatch.sourceLang,
      genres: libraryMatch.genres || []
    };
  }

  return null;
}

export function prefetchMangaDetails(mangaId) {
  const id = Number(mangaId);
  if (!Number.isInteger(id) || detailsMangaCache.has(id) || mangaDetailsPrefetching.has(id)) return;

  mangaDetailsPrefetching.add(id);
  request(`/api/mangas/${id}`, {
    headers: authHeaders(false),
    cacheTtlMs: 120000
  })
    .then((data) => {
      detailsMangaCache.set(id, data);
    })
    .catch(() => {})
    .finally(() => {
      mangaDetailsPrefetching.delete(id);
    });
}

export function applyMangaStatePatch(mangaId, patch = {}) {
  const targetId = Number(mangaId);
  if (!Number.isInteger(targetId)) return;

  const applyPatch = (item) => {
    if (!item) return item;
    const id = Number(item.id || item.mangaId);
    if (id !== targetId) return item;
    return { ...item, ...patch };
  };

  state.mangas = state.mangas.map(applyPatch);
  state.recommendations = state.recommendations.map(applyPatch);
  state.ranking = state.ranking.map(applyPatch);
  state.library = state.library.map(applyPatch);

  if (Number(state.details.mangaId) === targetId) {
    const currentManga = state.details.manga;
    if (currentManga) {
      state.details.manga = { ...currentManga, ...patch };
      renderDetails();
    }
  }
}

export function renderDetails() {
  const manga = state.details.manga;
  const isLoading = state.details.isLoadingChapters && !manga;

  if (!manga) {
    els.detailsCover.src = FALLBACK_COVER;
    delete els.detailsCover.dataset.src;
    els.detailsCover.classList.remove('lazy-image');
    els.detailsTitle.textContent = isLoading ? 'Loading details...' : 'Select a manga';
    els.detailsMeta.textContent = isLoading ? 'Fetching manga information.' : 'Status and manga information.';
    els.detailsCategories.innerHTML = '';
    els.detailsDescription.textContent = '';
    els.detailsSourceSelect.innerHTML = isLoading ? '<option value="">Loading...</option>' : '<option value="">Default source</option>';
    els.detailsSourceSelect.value = '';
    els.detailsChapterSelect.innerHTML = isLoading ? '<option value="">Loading...</option>' : '<option value="">No chapters</option>';
    els.detailsPageSelect.innerHTML = '<option value="1">Page 1</option>';
    els.detailsChapterInfo.textContent = isLoading ? 'Loading chapters...' : 'No chapter selected.';
    els.detailsFavoriteBtn.textContent = 'Favorite';
    els.detailsLibraryBtn.textContent = 'Add to library';
    return;
  }

  const chapters = state.details.chapters || [];
  let selectedChapter = chapters.find((chapter) => chapter.id === state.details.selectedChapterId);
  
  // If selected chapter doesn't exist, pick the first one
  if (!selectedChapter && chapters.length > 0) {
    selectedChapter = chapters[0];
    state.details.selectedChapterId = selectedChapter.id;
  }
  
  const chapterPages = Math.max(1, Number(selectedChapter?.pages) || 1);
  const selectedPage = Math.max(1, Number(state.details.selectedPage) || 1);
  const pageOptionsMax = Math.max(chapterPages, selectedPage, 1);
  
  els.detailsCover.src = coverSrc(manga.coverUrl);
  delete els.detailsCover.dataset.src;
  els.detailsCover.classList.remove('lazy-image');
  
  els.detailsTitle.textContent = manga.title;
  els.detailsMeta.textContent = `${manga.author || 'Unknown author'} • ${formatStatusLabel(manga.publicationStatus)} • ${manga.totalChapters || 0} chapters • ${formatLanguageLabel(
    manga.sourceLang || manga.sourceLanguage
  )}`;
  els.detailsCategories.innerHTML = formatCategories(manga.genres, 'Sem gênero');
  els.detailsDescription.textContent = manga.description || 'No description available.';
  els.detailsFavoriteBtn.textContent = manga.isFavorited ? 'Desfavoritar' : 'Favoritar';
  els.detailsFavoriteBtn.classList.toggle('btn-primary', Boolean(manga.isFavorited));
  els.detailsFavoriteBtn.dataset.mangaId = manga.id;

  els.detailsLibraryBtn.textContent = manga.inLibrary ? 'Na biblioteca' : 'Adicionar biblioteca';
  els.detailsLibraryBtn.classList.toggle('btn-primary', Boolean(manga.inLibrary));
  els.detailsLibraryBtn.dataset.mangaId = manga.id;
  els.detailsLibraryBtn.dataset.action = manga.inLibrary ? 'remove-library' : 'add-library';

  els.detailsManageCategoriesBtn.dataset.mangaId = manga.id;
  els.detailsManageCategoriesBtn.classList.toggle('hidden', !manga.inLibrary);

  els.detailsReportBtn.dataset.mangaId = manga.id;
  els.detailsOpenReaderBtn.dataset.mangaId = manga.id;

  const isAdmin = state.user?.isAdmin;
  if (els.detailsConfigBtn) {
    els.detailsConfigBtn.classList.toggle('hidden', !isAdmin);
    els.detailsConfigBtn.dataset.mangaId = manga.id;
  }

  if (els.detailsAdminToolsBtn) {
    els.detailsAdminToolsBtn.classList.toggle('hidden', !isAdmin);
    els.detailsAdminToolsBtn.dataset.mangaId = manga.id;
  }

  const sources = (Array.isArray(state.details.sources) ? state.details.sources : []).slice().sort((a, b) => {
    const chapterDiff = Math.max(0, Number(b.chaptersInLanguage) || 0) - Math.max(0, Number(a.chaptersInLanguage) || 0);
    if (chapterDiff !== 0) return chapterDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });
  
  const selectedSourceCandidate = String(state.details.selectedSourceId || '').trim();
  const sourceExists = sources.some((source) => String(source.id || '').trim() === selectedSourceCandidate);
  const selectedSourceId = sourceExists ? selectedSourceCandidate : String(sources[0]?.id || '').trim();
  state.details.selectedSourceId = selectedSourceId;

  const sourceOptions = sources
    .map((source) => {
      const sId = String(source.id || '').trim();
      const sName = String(source.name || 'Fonte externa').trim();
      const sLang = String(source.language || source.sourceLang || '').trim();
      const chaptersInLanguage = Math.max(0, Number(source.chaptersInLanguage) || 0);
      const totalChapters = Math.max(chaptersInLanguage, Number(source.totalChapters) || 0);
      const countLabel = chaptersInLanguage === 1 ? '1 cap.' : `${chaptersInLanguage} caps.`;
      const totalLabel = totalChapters > chaptersInLanguage ? ` / total ${totalChapters}` : '';
      const languageLabel = sLang ? ` • ${formatLanguageLabel(sLang)}` : '';
      return `<option value="${escapeHtml(sId)}">${escapeHtml(`${sName}${languageLabel} (${countLabel}${totalLabel})`)}</option>`;
    })
    .join('');

  els.detailsSourceSelect.innerHTML = sourceOptions || '<option value="">Nenhuma fonte no idioma selecionado</option>';
  els.detailsSourceSelect.value = selectedSourceId || '';

  const selectedSource = sources.find((source) => String(source.id || '').trim() === selectedSourceId) || null;
  state.details.selectedSourceName = selectedSource?.name || '';
  state.details.selectedSourceLanguage = selectedSource?.language || selectedSource?.sourceLang || state.details.selectedLanguage || '';

  const availableDetailLanguages = ['pt-br', 'en', 'es'];
  const preferredLanguage = normalizeUiProfileLanguage(state.settings.preferredLanguage, 'pt-br');
  const languageOptions = availableDetailLanguages
    .map((lang) => `<option value="${lang}">${escapeHtml(formatLanguageLabel(lang))}</option>`)
    .join('');

  els.detailsLanguageFilter.innerHTML = languageOptions;
  if (els.detailsLanguageFilter.querySelector(`option[value="${state.details.selectedLanguage}"]`)) {
    els.detailsLanguageFilter.value = state.details.selectedLanguage;
  } else {
    state.details.selectedLanguage = preferredLanguage;
    els.detailsLanguageFilter.value = preferredLanguage;
  }

  const chapterOptions = chapters
    .map(
      (chapter) =>
        `<option value="${chapter.id}">Cap. ${escapeHtml(chapter.number)}${chapter.title ? ` - ${escapeHtml(chapter.title)}` : ''} (${escapeHtml(
          formatLanguageLabel(chapter.language)
        )})</option>`
    )
    .join('');

  els.detailsChapterSelect.innerHTML = chapterOptions || '<option value="">Sem chapters disponíveis</option>';

  if (selectedChapter) {
    els.detailsChapterSelect.value = selectedChapter.id;
    els.detailsPageSelect.innerHTML = buildNumberOptions(pageOptionsMax, selectedPage, 'Pág.');
    const sourceLabel = selectedSource?.name ? `Fonte ${selectedSource.name} • ` : '';
    els.detailsChapterInfo.textContent = `${sourceLabel}Capítulo ${selectedChapter.number} • ${formatLanguageLabel(selectedChapter.language)} • ${chapterPages} páginas`;
  } else {
    els.detailsPageSelect.innerHTML = '<option value="1">Pág. 1</option>';
    els.detailsChapterInfo.textContent =
      sources.length === 0 ? 'Nenhuma fonte disponível no idioma selecionado.' : 'Sem capítulo selecionado.';
  }

  observeLazyImages(els.detailsView);
}

export async function openDetails(mangaId, resumeFromLibrary = false, callbacks = {}) {
  const { goToView, setDetailsTabVisible, persistUiState, renderDetails, loadDetailsChapters } = callbacks;
  const nextMangaId = Number(mangaId);
  if (!Number.isInteger(nextMangaId)) return;

  const isDifferentManga = Number(state.details.mangaId) !== nextMangaId;
  if (state.view !== 'details' && state.view !== 'reader') {
    state.previousView = state.view;
  }

  setDetailsTabVisible(true);
  goToView('details');
  persistUiState();

  state.details.mangaId = nextMangaId;
  state.details.isLoadingChapters = true;

  if (isDifferentManga) {
    state.details.selectedSourceId = '';
    state.details.selectedSourceName = '';
    state.details.selectedSourceLanguage = '';
    state.details.selectedLanguage = normalizeUiProfileLanguage(state.settings.preferredLanguage, 'pt-br');
    state.details.sources = [];
    state.details.selectedChapterId = '';
    state.details.selectedPage = 1;
    state.details.chapters = [];
    state.details.availableLanguages = [];
  }

  const preview = findMangaPreviewById(nextMangaId);
  if (preview) {
    state.details.manga = preview;
    const previewSourceId = String(preview?.progress?.sourceId || preview?.sourceId || '').trim();
    const previewSourceLanguage = normalizeUiProfileLanguage(
      preview?.progress?.sourceLanguage || preview?.sourceLanguage || preview?.sourceLang,
      state.settings.preferredLanguage || 'pt-br'
    );
    if (previewSourceId) {
      state.details.selectedSourceId = previewSourceId;
    }
    if (previewSourceLanguage) {
      state.details.selectedLanguage = previewSourceLanguage;
    }
  }

  renderDetails();

  try {
    const previewProgressChapter = resumeFromLibrary ? (preview?.progress?.chapterId || null) : null;
    const previewProgressPage = resumeFromLibrary ? Math.max(1, Number(preview?.progress?.lastPage) || 1) : 1;

    let data = detailsMangaCache.get(nextMangaId);
    if (!data) {
      data = await request(`/api/mangas/${nextMangaId}`, {
        headers: authHeaders(false),
        cacheTtlMs: 90000
      });
      detailsMangaCache.set(nextMangaId, data);
    }
    
    if (Number(state.details.mangaId) !== nextMangaId) return;
    
    state.details.manga = data.manga || data;
    applyMangaStatePatch(nextMangaId, { ...state.details.manga });

    await loadDetailsChapters(nextMangaId, previewProgressChapter, previewProgressPage);

    if (Number(state.details.mangaId) !== nextMangaId) return;
    state.details.isLoadingChapters = false;
    renderDetails();
  } catch (err) {
    state.details.isLoadingChapters = false;
    renderDetails();
    showToast(err.message);
  }
}
