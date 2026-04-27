import { state, els } from '../state.js';
import { escapeHtml } from './format.js';

let lazyImageLoader = null;
let readerImageCleanup = null;

export function setModalVisibility(modalEl, visible) {
  if (!modalEl) return;
  modalEl.classList.toggle('hidden', !visible);
  if (visible) {
    modalEl.removeAttribute('hidden');
  } else {
    modalEl.setAttribute('hidden', 'hidden');
  }
}

export function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 3000);
}

export function emptyHtml(message) {
  return `<div class="empty">${message}</div>`;
}

export function updateModalBodyLock() {
  if (state.view === 'reader') {
    document.body.style.overflow = 'hidden';
    return;
  }

  const hasOpenModal = [els.libraryFiltersModal, els.mangaCategoriesModal, els.appDialogModal].some(
    (modal) => modal && !modal.classList.contains('hidden')
  );
  document.body.style.overflow = hasOpenModal ? 'hidden' : '';
}

export function buildNumberOptions(maxValue, selectedValue, prefix = '') {
  const safeMax = Math.max(1, Math.min(1000, Number(maxValue) || 1));
  const safeSelected = Math.max(1, Math.min(safeMax, Number(selectedValue) || 1));
  const options = [];

  for (let index = 1; index <= safeMax; index += 1) {
    const selected = index === safeSelected ? 'selected' : '';
    const label = prefix ? `${prefix} ${index}` : String(index);
    options.push(`<option value="${index}" ${selected}>${escapeHtml(label)}</option>`);
  }

  return options.join('');
}

export function initLazyLoader(loader) {
  lazyImageLoader = loader;
}

export function observeLazyImages(target = document) {
  if (!lazyImageLoader) {
    const nodes = target instanceof Element ? target.querySelectorAll('img[data-src]') : document.querySelectorAll('img[data-src]');
    nodes.forEach((img) => {
      if (!img.dataset.src) return;
      img.src = img.dataset.src;
    });
    return;
  }
  lazyImageLoader.observe(target);
}

export function setReaderImageCleanup(cleanup) {
  readerImageCleanup = cleanup;
}

export function clearReaderImageObserver() {
  if (!readerImageCleanup) return;
  readerImageCleanup();
  readerImageCleanup = null;
}

export function updateDiscoverLoadMoreVisibility() {
  if (!els.discoverLoadMore) return;

  const shouldShow = state.view === 'discover' && state.mangas.length > 0 && (state.discover.hasMore || state.discover.isLoadingMore);
  els.discoverLoadMore.classList.toggle('hidden', !shouldShow);
  els.discoverLoadMore.textContent = state.discover.isLoadingMore ? 'Loading more manga...' : '';
}
