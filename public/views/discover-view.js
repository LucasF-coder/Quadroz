import { state, els, FALLBACK_COVER, getDefaultLibraryAdvancedFilters } from '../state.js';
import { 
  escapeHtml, truncateText, formatStatusLabel, formatLanguageLabel, formatCategories, coverSrc 
} from '../utils/format.js';
import { observeLazyImages, updateDiscoverLoadMoreVisibility } from '../utils/dom.js';

export function renderDiscoverCards(mangas, emptyMessage = 'No manga found para esse filtro.') {
  const list = Array.isArray(mangas) ? mangas : [];
  if (list.length === 0) {
    return `<div class="empty">${emptyMessage}</div>`;
  }

  return list
    .map(
      (manga) => `
      <article class="card" data-manga-id="${manga.id}" data-open-details="true">
        <img class="card-cover lazy-image" src="${FALLBACK_COVER}" data-src="${coverSrc(manga.coverUrl)}" alt="Capa de ${escapeHtml(
          manga.title
        )}" loading="lazy" decoding="async" />
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(truncateText(manga.title, 76))}</h3>
          <div class="card-meta">${escapeHtml(manga.author)} • ${formatStatusLabel(manga.publicationStatus)} • ${manga.favoriteCount} favoritos</div>
          <div class="card-language">${formatLanguageLabel(manga.sourceLang)}</div>
          <p class="card-desc">${escapeHtml(truncateText(manga.description, 220))}</p>
          <div class="chips">${formatCategories(manga.genres, 'Sem gênero')}</div>

          <div class="card-actions">
            <button class="btn ${manga.isFavorited ? 'btn-primary' : ''}" data-action="toggle-favorite" data-manga-id="${manga.id}">
              ${manga.isFavorited ? 'Desfavoritar' : 'Favoritar'}
            </button>
            <button class="btn ${manga.inLibrary ? 'btn-primary' : ''}" data-action="add-library" data-manga-id="${manga.id}">
              ${manga.inLibrary ? 'Na biblioteca' : 'Adicionar biblioteca'}
            </button>
            <button class="btn" data-action="open-details" data-manga-id="${manga.id}">Ver detalhes</button>
          </div>
        </div>
      </article>
    `
    )
    .join('');
}

export function resetDiscoverPagination() {
  state.discover.cursor = 0;
  state.discover.hasMore = true;
  state.discover.isLoadingMore = false;
}

export function updateRecommendationsVisibility() {
  if (!els.discoverRecommendHead) return;
  const hasSearch = Boolean(state.discover.search);
  els.discoverRecommendHead.classList.toggle('hidden', hasSearch);
els.discoverRecommendationsGrid.classList.toggle('hidden', hasSearch);
}

export function countAdvancedFilterRules(filtersState) {
  const source = filtersState && typeof filtersState === 'object' ? filtersState : getDefaultLibraryAdvancedFilters();
  return Object.values(source).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0);
}

export function renderDiscoverFilterSummary(totalItems, visibleItems) {
  if (!els.discoverFilterSummary) return;
  const selectedCount = countAdvancedFilterRules(state.discover.advanced);
  if (selectedCount > 0) {
    els.discoverFilterSummary.textContent = `${visibleItems}/${totalItems} itens • ${selectedCount} regras avançadas`;
    return;
  }
  els.discoverFilterSummary.textContent = `${visibleItems}/${totalItems} itens`;
}

export function renderRecommendations() {
  if (!els.discoverRecommendationsGrid || !els.discoverRecommendationsMeta) return;
  const list = Array.isArray(state.recommendations) ? state.recommendations : [];
  const mode = state.recommendationsMeta?.mode === 'personalized_random'
    ? 'Personalizadas com exploração aleatória'
    : 'Aleatórias';
  const count = list.length;
  els.discoverRecommendationsMeta.textContent = `${mode} • ${count} itens`;
  els.discoverRecommendationsGrid.innerHTML = renderDiscoverCards(
    list,
    'Ainda não há recomendações disponíveis.'
  );
  observeLazyImages(els.discoverRecommendationsGrid);
}

export function renderMangas() {
  const filteredMangas = getFilteredDiscoverMangas();
  const html = renderDiscoverCards(filteredMangas, 'No manga found para esse filtro.');
  
  els.mangaGrid.innerHTML = html;

  renderDiscoverFilterSummary(state.mangas.length, filteredMangas.length);
  observeLazyImages(els.mangaGrid);
  updateDiscoverLoadMoreVisibility();
  updateRecommendationsVisibility();
}

export function getFilteredDiscoverMangas() {
  return state.mangas || [];
}
