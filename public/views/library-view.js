import { state, els, FALLBACK_COVER, getDefaultLibraryAdvancedFilters } from '../state.js';
import { escapeHtml, truncateText, coverSrc } from '../utils/format.js';
import { observeLazyImages, updateModalBodyLock } from '../utils/dom.js';

let advancedFiltersDraft = null;
let advancedFiltersContext = 'library';

export function renderLibrary() {
  // Garantir que window.libraryView existe para os eventos inline do modal
  if (!window.libraryView) {
    window.libraryView = {
      setStrict: () => {},
      toggleGenre: () => {},
      toggleSource: () => {}
    };
  }

  const items = filterAndSortItems(state.library, state.libraryFilters);
  els.libraryGrid.innerHTML = items.map(m => `
    <article class="card" data-manga-id="${m.mangaId}">
      <img class="card-cover lazy-image" src="${FALLBACK_COVER}" data-src="${coverSrc(m.coverUrl)}" data-action="open-details" data-manga-id="${m.mangaId}" />
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(truncateText(m.title, 60))}</h3>
        <p class="card-meta">Cap. ${m.progress?.currentChapter || 1} • Pág. ${m.progress?.lastPage || 1}</p>
        <div class="card-actions">
          <button class="btn btn-primary" data-action="remove-library" data-manga-id="${m.mangaId}">Na biblioteca</button>
        </div>
      </div>
    </article>
  `).join('') || '<div class="empty">Biblioteca vazia.</div>';
  observeLazyImages(els.libraryGrid);
}

function filterAndSortItems(list, f) {
  const adv = f.advanced || getDefaultLibraryAdvancedFilters();
  const includeGenres = (Array.isArray(adv.includeGenres) ? adv.includeGenres : []).map(g => String(g).toLowerCase());
  const excludeGenres = (Array.isArray(adv.excludeGenres) ? adv.excludeGenres : []).map(g => String(g).toLowerCase());
  const sourcesFilter = Array.isArray(adv.sources) ? adv.sources.map(String) : [];

  let res = (list || []).map(item => {
    const genres = (Array.isArray(item.genres) ? item.genres : []).map(g => String(g).toLowerCase());
    const matchCount = includeGenres.filter(g => genres.includes(g)).length;
    return { ...item, _matchCount: matchCount };
  });

  if (f.search) {
    const s = String(f.search).toLowerCase();
    res = res.filter(i => String(i.title).toLowerCase().includes(s) || String(i.author || '').toLowerCase().includes(s));
  }

  res = res.filter(i => {
    const genres = (Array.isArray(i.genres) ? i.genres : []).map(g => String(g).toLowerCase());

    if (includeGenres.length > 0) {
      const hasAll = includeGenres.every(g => genres.includes(g));
      const hasAny = includeGenres.some(g => genres.includes(g));
      if (adv.strictInclude && !hasAll) return false;
      if (!adv.strictInclude && !hasAny) return false;
    }

    if (excludeGenres.length > 0) {
      const hasAll = excludeGenres.every(g => genres.includes(g));
      const hasAny = excludeGenres.some(g => genres.includes(g));
      if (adv.strictExclude && hasAll) return false;
      if (!adv.strictExclude && hasAny) return false;
    }

    if (sourcesFilter.length > 0 && !sourcesFilter.includes(String(i.sourceId))) return false;
    return true;
  });

  return res.sort((a, b) => b._matchCount - a._matchCount || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export async function openAdvancedFiltersModal(context = 'library') {
  advancedFiltersContext = context;
  const current = (context === 'library' ? state.libraryFilters.advanced : state.discover.advanced) || {};
  advancedFiltersDraft = JSON.parse(JSON.stringify({
    ...getDefaultLibraryAdvancedFilters(),
    sources: [],
    ...current
  }));
  
  const allGenres = Array.from(new Set(state.mangas.flatMap(m => m.genres || []).map(g => g.trim()))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  
  if (!state.admin.enabledSources || state.admin.enabledSources.length === 0) {
    try {
      const d = await request('/api/sources/enabled');
      state.admin.enabledSources = d.sources || [];
    } catch {
      state.admin.enabledSources = [];
    }
  }
  const sources = state.admin.enabledSources || [];

  els.libraryFiltersModalBody.innerHTML = `
    <div class="filter-group">
      <h4>Gêneros para Incluir</h4>
      <div class="inline-tools"><label><input type="checkbox" ${advancedFiltersDraft.strictInclude ? 'checked' : ''} onchange="window.libraryView.setStrict('include', this.checked)"> Somente se tiver TODOS</label></div>
      <div class="chips-grid">${allGenres.map(g => `<label class="chip-check"><input type="checkbox" ${advancedFiltersDraft.includeGenres.includes(g) ? 'checked' : ''} onchange="window.libraryView.toggleGenre('include', '${g}', this.checked)"><span>${g}</span></label>`).join('')}</div>
    </div>
    <div class="filter-group">
      <h4>Gêneros para Excluir</h4>
      <div class="inline-tools"><label><input type="checkbox" ${advancedFiltersDraft.strictExclude ? 'checked' : ''} onchange="window.libraryView.setStrict('exclude', this.checked)"> Somente se tiver TODOS</label></div>
      <div class="chips-grid">${allGenres.map(g => `<label class="chip-check color-danger"><input type="checkbox" ${advancedFiltersDraft.excludeGenres.includes(g) ? 'checked' : ''} onchange="window.libraryView.toggleGenre('exclude', '${g}', this.checked)"><span>${g}</span></label>`).join('')}</div>
    </div>
    <div class="filter-group">
      <h4>Fontes</h4>
      <div class="chips-grid">${sources.map(s => `<label class="chip-check"><input type="checkbox" ${advancedFiltersDraft.sources?.includes(String(s.source_id)) ? 'checked' : ''} onchange="window.libraryView.toggleSource('${s.source_id}', this.checked)"><span>${s.source_name}</span></label>`).join('')}</div>
    </div>
  `;

  window.libraryView = {
    setStrict: (type, val) => { if (type === 'include') advancedFiltersDraft.strictInclude = val; else advancedFiltersDraft.strictExclude = val; },
    toggleGenre: (type, g, c) => {
      const list = type === 'include' ? advancedFiltersDraft.includeGenres : advancedFiltersDraft.excludeGenres;
      if (c) { if(!list.includes(g)) list.push(g); } else { const idx = list.indexOf(g); if (idx > -1) list.splice(idx, 1); }
    },
    toggleSource: (id, c) => {
      if (!advancedFiltersDraft.sources) advancedFiltersDraft.sources = [];
      if (c) { if(!advancedFiltersDraft.sources.includes(String(id))) advancedFiltersDraft.sources.push(String(id)); }
      else advancedFiltersDraft.sources = advancedFiltersDraft.sources.filter(i => i !== String(id));
    }
  };

  els.libraryFiltersModal.classList.remove('hidden'); updateModalBodyLock();
}

export function applyAdvancedFilters() {
  if (advancedFiltersContext === 'library') state.libraryFilters.advanced = advancedFiltersDraft;
  else state.discover.advanced = advancedFiltersDraft;
  els.libraryFiltersModal.classList.add('hidden'); updateModalBodyLock();
  if (advancedFiltersContext === 'library') renderLibrary();
}

export function clearAdvancedFilters() {
  advancedFiltersDraft = { ...getDefaultLibraryAdvancedFilters(), sources: [] };
  applyAdvancedFilters();
}
