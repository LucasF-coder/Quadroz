import { state, els, assetPath } from '../state.js';
import { request, authHeaders } from '../services/request.js';
import { formatLanguageLabel, formatDateTime } from '../utils/format.js';
import { emptyHtml, buildNumberOptions, clearReaderImageObserver, showToast, observeLazyImages } from '../utils/dom.js';

let pageObserver = null;
let lastPageObserver = null;
let firstPageObserver = null;
let clickTimer = null;

export function renderReaderOverlay() {
  const chapters = state.reader.chapters || [];
  const currentChapterId = state.reader.currentChapterId;
  const bookmarkChapterId = state.reader.bookmark?.chapterId;

  els.readerChapterSelect.innerHTML = chapters.map(c => {
    const isMarked = String(c.id) === String(bookmarkChapterId);
    return `<option value="${c.id}" ${String(c.id) === String(currentChapterId) ? 'selected' : ''}>${isMarked ? '📌 ' : ''}Ch. ${c.number || c.chapterNumber || '?'}</option>`;
  }).join('');

  const total = state.reader.totalPages || state.reader.pages.length || 1;
  els.readerPageSelect.innerHTML = buildNumberOptions(total, state.reader.currentPage, 'Pg.');
  
  const isChapterMarked = String(currentChapterId) === String(bookmarkChapterId);
  els.readerBookmarkBtn.textContent = isChapterMarked ? 'Unmark Chapter' : 'Mark Chapter';
  els.readerBookmarkBtn.classList.toggle('btn-primary', isChapterMarked);

  renderReaderSubtitle();
}

export function toggleReaderOverlay() {
  state.reader.showOverlay = !state.reader.showOverlay;
  els.readerOverlay.classList.toggle('hidden', !state.reader.showOverlay);
  els.readerView.classList.toggle('reader-overlay-visible', state.reader.showOverlay);
  if (state.reader.showOverlay) {
    renderReaderOverlay();
    if (els.readerChapterSelect) els.readerChapterSelect.value = state.reader.currentChapterId;
    if (els.readerPageSelect) els.readerPageSelect.value = state.reader.currentPage;
  }
}

export function renderReaderSubtitle() {
  const c = state.reader.chapters.find(i => String(i.id) === String(state.reader.currentChapterId));
  const total = Math.max(1, state.reader.totalPages || state.reader.pages.length);
  els.readerSubtitle.textContent = `Ch. ${c?.number || '?'} • Page ${state.reader.currentPage}/${total}`;
}

function updateReaderState(chapterId, pageIndex) {
  let changed = false;
  
  if (chapterId && String(state.reader.currentChapterId) !== String(chapterId)) {
    state.reader.currentChapterId = chapterId;
    const chapter = state.reader.chapters.find(c => String(c.id) === String(chapterId));
    state.reader.totalPages = chapter?.pages || 0;
    if (els.readerChapterSelect) els.readerChapterSelect.value = chapterId;
    if (state.reader.showOverlay) renderReaderOverlay();
    if (state.reader.mode === 'scroll') pruneFarChapters(chapterId);
    changed = true;
  }
  
  if (pageIndex !== undefined && state.reader.currentPage !== pageIndex) {
    state.reader.currentPage = pageIndex;
    if (els.readerPageSelect) els.readerPageSelect.value = pageIndex;
    changed = true;
  }

  if (changed) {
    renderReaderSubtitle();
    if (typeof state.reader.onPageChange === 'function') {
      state.reader.onPageChange();
    }
  }
}

function pruneFarChapters(activeChapterId) {
  const allWraps = els.readerCanvas.querySelectorAll('.reader-chapter-wrap');
  const chapterIds = state.reader.chapters.map(c => String(c.id));
  const activeIdx = chapterIds.indexOf(String(activeChapterId));
  if (activeIdx === -1) return;
  allWraps.forEach(wrap => {
    const cid = String(wrap.dataset.chapterId);
    const idx = chapterIds.indexOf(cid);
    if (Math.abs(idx - activeIdx) > 1) {
      wrap.remove();
    }
  });
}

function initScrollObservers() {
  if (pageObserver) pageObserver.disconnect();
  if (lastPageObserver) lastPageObserver.disconnect();
  if (firstPageObserver) firstPageObserver.disconnect();

  pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.1) {
        const pageIndex = parseInt(entry.target.dataset.index);
        const chapterId = entry.target.dataset.chapterId;
        updateReaderState(chapterId, pageIndex);
      }
    });
  }, { 
    threshold: [0, 0.1, 0.5],
    root: els.readerCanvas,
    rootMargin: '-10% 0px -40% 0px'
  });

  lastPageObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry && entry.isIntersecting && !state.reader.isLoadingNextChapter) {
      const idx = state.reader.chapters.findIndex(i => String(i.id) === String(state.reader.currentChapterId));
      if (idx >= 0 && idx < state.reader.chapters.length - 1) {
        const nextChapterId = state.reader.chapters[idx + 1].id;
        if (!document.querySelector(`.reader-chapter-wrap[data-chapter-id="${nextChapterId}"]`)) {
          changeReaderChapter(nextChapterId, 1, true);
        }
      }
    }
  }, {
    root: els.readerCanvas,
    rootMargin: '1200px' 
  });

  firstPageObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry && entry.isIntersecting && !state.reader.isLoadingPrevChapter) {
      const chapterId = entry.target.dataset.chapterId;
      if (!chapterId) return;
      const idx = state.reader.chapters.findIndex(i => String(i.id) === String(chapterId));
      if (idx > 0) {
        const prevChapterId = state.reader.chapters[idx - 1].id;
        if (!document.querySelector(`.reader-chapter-wrap[data-chapter-id="${prevChapterId}"]`)) {
          prependChapterContent(prevChapterId);
        }
      }
    }
  }, {
    root: els.readerCanvas,
    rootMargin: '1200px 0px 0px 0px'
  });
}

export function renderReaderContent() {
  clearReaderImageObserver();
  if (pageObserver) pageObserver.disconnect();
  if (lastPageObserver) lastPageObserver.disconnect();
  if (firstPageObserver) firstPageObserver.disconnect();
  
  const pages = state.reader.pages;
  
  if (state.reader.mode === 'scroll') {
    els.readerCanvas.classList.add('scroll-mode');
    els.readerView.classList.add('reader-mode-scroll');
    if (!pages.length) { els.readerCanvas.innerHTML = emptyHtml('No pages.'); return; }
    
    initScrollObservers();
    els.readerCanvas.innerHTML = ''; 
    appendChapterContent(state.reader.currentChapterId, pages);

    els.readerCanvas._scrollClickHandler && els.readerCanvas.removeEventListener('click', els.readerCanvas._scrollClickHandler);
    els.readerCanvas._scrollClickHandler = (e) => {
      if (e.target.closest('a,button,select,option')) return;
      handleReaderClick();
    };
    els.readerCanvas.addEventListener('click', els.readerCanvas._scrollClickHandler);

    if (state.reader.currentPage >= 1) {
      setTimeout(() => {
        const el = document.getElementById(`p${state.reader.currentChapterId}-${state.reader.currentPage}`);
        if (el) el.scrollIntoView();
      }, 150);
    }
  } else {
    els.readerCanvas.classList.remove('scroll-mode');
    els.readerView.classList.remove('reader-mode-scroll');
    if (els.readerCanvas._scrollClickHandler) {
      els.readerCanvas.removeEventListener('click', els.readerCanvas._scrollClickHandler);
      els.readerCanvas._scrollClickHandler = null;
    }
    if (!pages.length) { els.readerCanvas.innerHTML = emptyHtml('No pages.'); return; }
    const p = pages.find(i => Number(i.index) === state.reader.currentPage) || pages[0];
    
    // Simplified to avoid zoom/drag and allow natural scroll if the image is larger than the screen
    els.readerCanvas.innerHTML = `
      <div class="reader-single-wrap">
        <img class="reader-single-page" src="${p.url}" draggable="false" />
      </div>
    `;
    
    // Re-adds click for overlay in paged mode
    const wrap = els.readerCanvas.querySelector('.reader-single-wrap');
    wrap.onclick = (e) => {
      if (e.target.closest('a,button,select,option')) return;
      handleReaderClick();
    };
  }
}

function appendChapterContent(chapterId, pages) {
  const chapterWrap = document.createElement('div');
  chapterWrap.className = 'reader-chapter-wrap';
  chapterWrap.dataset.chapterId = chapterId;
  chapterWrap.style.cssText = 'width:100%!important;max-width:100%!important;display:block!important;box-sizing:border-box!important;';
  
  const chapterHeader = document.createElement('div');
  chapterHeader.className = 'reader-chapter-divider';
  const chapterInfo = state.reader.chapters.find(c => String(c.id) === String(chapterId));
  chapterHeader.textContent = `Chapter ${chapterInfo?.number || '?'}`;
  chapterWrap.appendChild(chapterHeader);
  
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'reader-scroll-wrap';
  scrollWrap.innerHTML = pages.map(p => `
    <div class="reader-scroll-item" id="p${chapterId}-${p.index}" data-index="${p.index}" data-chapter-id="${chapterId}">
      <img class="reader-scroll-image lazy-image" data-src="${p.url}" />
    </div>`).join('');
  chapterWrap.appendChild(scrollWrap);
  els.readerCanvas.appendChild(chapterWrap);
  
  chapterWrap.querySelectorAll('.reader-scroll-item').forEach(el => pageObserver.observe(el));
  const lastItem = chapterWrap.querySelector('.reader-scroll-item:last-child');
  if (lastItem) lastPageObserver.observe(lastItem);
  const firstItem = chapterWrap.querySelector('.reader-scroll-item:first-child');
  if (firstItem) firstPageObserver.observe(firstItem);
  observeLazyImages(chapterWrap);
}

async function prependChapterContent(chapterId) {
  if (state.reader.isLoadingPrevChapter) return;
  state.reader.isLoadingPrevChapter = true;
  try {
    const d = await request(`/api/chapters/${chapterId}/pages`, { headers: authHeaders(false) });
    const newPages = d.pages || [];
    const chapterWrap = document.createElement('div');
    chapterWrap.className = 'reader-chapter-wrap';
    chapterWrap.dataset.chapterId = chapterId;
    chapterWrap.style.cssText = 'width:100%!important;max-width:100%!important;display:block!important;box-sizing:border-box!important;';
    const chapterHeader = document.createElement('div');
    chapterHeader.className = 'reader-chapter-divider';
    const chapterInfo = state.reader.chapters.find(c => String(c.id) === String(chapterId));
    chapterHeader.textContent = `Chapter ${chapterInfo?.number || '?'}`;
    chapterWrap.appendChild(chapterHeader);
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'reader-scroll-wrap';
    scrollWrap.innerHTML = newPages.map(p => `
      <div class="reader-scroll-item" id="p${chapterId}-${p.index}" data-index="${p.index}" data-chapter-id="${chapterId}">
        <img class="reader-scroll-image lazy-image" data-src="${p.url}" />
      </div>`).join('');
    chapterWrap.appendChild(scrollWrap);
    const canvas = els.readerCanvas;
    const prevScrollHeight = canvas.scrollHeight;
    canvas.insertBefore(chapterWrap, canvas.firstChild);
    canvas.scrollTop += canvas.scrollHeight - prevScrollHeight;
    chapterWrap.querySelectorAll('.reader-scroll-item').forEach(el => pageObserver.observe(el));
    const lastItem = chapterWrap.querySelector('.reader-scroll-item:last-child');
    if (lastItem) lastPageObserver.observe(lastItem);
    const firstItem = chapterWrap.querySelector('.reader-scroll-item:first-child');
    if (firstItem) firstPageObserver.observe(firstItem);
    observeLazyImages(chapterWrap);
  } catch (err) {
    showToast(`Error loading previous chapter: ${err.message}`);
  } finally {
    state.reader.isLoadingPrevChapter = false;
  }
}

export async function goToNextPage() {
  if (clickTimer) return;
  clickTimer = setTimeout(async () => {
    clickTimer = null;
    const total = state.reader.totalPages || state.reader.pages.length;
    if (state.reader.currentPage < total) {
      state.reader.currentPage++;
      if (state.reader.mode === 'paged') renderReaderContent();
      else {
        const el = document.getElementById(`p${state.reader.currentChapterId}-${state.reader.currentPage}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      updateReaderState(state.reader.currentChapterId, state.reader.currentPage);
    } else {
      const idx = state.reader.chapters.findIndex(i => String(i.id) === String(state.reader.currentChapterId));
      if (idx < state.reader.chapters.length - 1) {
        const nextId = state.reader.chapters[idx + 1].id;
        if (state.reader.mode === 'scroll') {
          const nextElem = document.getElementById(`p${nextId}-1`);
          if (nextElem) nextElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
          else await changeReaderChapter(nextId, 1, true);
        } else {
          showToast('Loading next chapter...');
          await changeReaderChapter(nextId, 1);
        }
      } else {
        showToast('End of manga. There is no next chapter.');
      }
    }
  }, 250);
}

export async function goToPreviousPage() {
  if (clickTimer) return;
  clickTimer = setTimeout(async () => {
    clickTimer = null;
    if (state.reader.currentPage > 1) {
      state.reader.currentPage--;
      if (state.reader.mode === 'paged') renderReaderContent();
      else {
        const el = document.getElementById(`p${state.reader.currentChapterId}-${state.reader.currentPage}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      updateReaderState(state.reader.currentChapterId, state.reader.currentPage);
    } else {
      const idx = state.reader.chapters.findIndex(i => String(i.id) === String(state.reader.currentChapterId));
      if (idx > 0) {
        const prevId = state.reader.chapters[idx - 1].id;
        const prevChapter = state.reader.chapters[idx - 1];
        const prevLastPage = prevChapter?.pages || 1;
        if (state.reader.mode === 'scroll') {
          const prevElem = document.getElementById(`p${prevId}-${prevLastPage}`);
          if (prevElem) prevElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
          else await changeReaderChapter(prevId, prevLastPage);
        } else {
          await changeReaderChapter(prevId, prevLastPage);
        }
      }
    }
  }, 250);
}

export function handleReaderClick() {
  if (clickTimer) return;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    toggleReaderOverlay();
  }, 250);
}

export async function changeReaderChapter(id, page = 1, append = false) {
  if (append && state.reader.isLoadingNextChapter) return;
  try {
    if (append) state.reader.isLoadingNextChapter = true;
    else state.reader.currentChapterId = id;
    const d = await request(`/api/chapters/${id}/pages`, { headers: authHeaders(false) });
    const newPages = d.pages || [];
    const newTotal = d.totalPages || newPages.length;
    if (append && state.reader.mode === 'scroll') {
      appendChapterContent(id, newPages);
    } else {
      state.reader.pages = newPages;
      state.reader.totalPages = newTotal;
      state.reader.currentPage = Math.min(page, state.reader.totalPages);
      renderReaderContent(); 
    }
    if (typeof state.reader.onPageChange === 'function') {
      state.reader.onPageChange();
    }
    if (state.reader.showOverlay) renderReaderOverlay();
    else renderReaderSubtitle();
  } catch (err) {
    showToast(`Error loading pages: ${err.message}`);
    if (!append) {
      state.reader.pages = [];
      renderReaderContent();
    }
  } finally {
    state.reader.isLoadingNextChapter = false;
  }
}

export async function openReader(cfg, o = {}) {
  Object.assign(state.reader, cfg);
  state.reader.onPageChange = o.onPageChange || null;
  els.readerTitle.textContent = cfg.title;
  o.goToView?.('reader');
  await changeReaderChapter(cfg.chapterId, cfg.page);
}

export async function toggleCurrentBookmark() {
  const isMarked = String(state.reader.bookmark?.chapterId) === String(state.reader.currentChapterId);
  if (isMarked) {
    await request(`/api/bookmarks/${state.reader.mangaId}`, { method: 'DELETE', headers: authHeaders() });
    state.reader.bookmark = null; showToast('Chapter bookmark removed.');
  } else {
    const d = await request(`/api/bookmarks/${state.reader.mangaId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ chapterId: state.reader.currentChapterId, pageIndex: state.reader.currentPage }) });
    state.reader.bookmark = d.bookmark; showToast('Chapter bookmarked.');
  }
  renderReaderOverlay();
}
export function getCurrentReaderChapter() { return state.reader.chapters.find(i => String(i.id) === String(state.reader.currentChapterId)); }
