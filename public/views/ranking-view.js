import { state, els } from '../state.js';
import { request, authHeaders } from '../services/request.js';
import { 
  formatStatusLabel, formatLanguageLabel, formatCategories 
} from '../utils/format.js';
import { emptyHtml } from '../utils/dom.js';

export function renderRankingItems(ranking, helpers) {
  const list = Array.isArray(ranking) ? ranking : [];
  if (list.length === 0) {
    return helpers.emptyHtml('Ainda não há dados de ranking para esse filtro.');
  }

  return list
    .map(
      (item) => `
      <article class="rank-item" data-manga-id="${item.id}" data-open-details="true">
        <div class="rank-badge">#${item.rank}</div>
        <div class="rank-main">
          <h3 class="rank-title">${helpers.escapeHtml(item.title)}</h3>
          <p class="rank-sub">${helpers.escapeHtml(item.author)} • ${helpers.formatStatusLabel(item.publicationStatus)} • ${
            item.favoriteCount
          } favoritos</p>
          <div class="chips">${helpers.formatCategories(item.genres, 'Sem gênero')}</div>
        </div>
        <button class="btn rank-favorite-btn ${item.isFavorited ? 'btn-primary' : ''}" data-action="toggle-favorite" data-manga-id="${item.id}">
          ${item.isFavorited ? 'Desfavoritar' : 'Favoritar'}
        </button>
      </article>
    `
    )
    .join('');
}

export async function loadRanking(options = {}) {
  const params = new URLSearchParams();
  if (state.rankingFilters.category) params.set('genre', state.rankingFilters.category);
  if (state.rankingFilters.status) params.set('status', state.rankingFilters.status);
  if (state.rankingFilters.language) params.set('language', state.rankingFilters.language);

  const data = await request(`/api/ranking?${params.toString()}`, {
    headers: authHeaders(false)
  });

  state.ranking = data.ranking || [];
  if (!options.skipRender) {
    renderRanking();
  }
}

export function renderRanking() {
  els.rankingList.innerHTML = renderRankingItems(state.ranking, {
    emptyHtml,
    escapeHtml: (str) => str,
    formatStatusLabel,
    formatLanguageLabel,
    formatCategories
  });
}
