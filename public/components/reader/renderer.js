import { createLazyImageLoader, getBlurPlaceholderDataUri } from '/hooks/useLazyImage.js';

const placeholderSrc = getBlurPlaceholderDataUri();

export function getReaderPlaceholder() {
  return placeholderSrc;
}

export function buildPagedImageHtml(page) {
  return `
    <div class="reader-single-wrap" id="reader-current-page-${page.index}">
      <img class="reader-single-page" src="${placeholderSrc}" data-src="${page.url}" alt="Página ${page.index}" draggable="false" fetchpriority="high" loading="eager" />
    </div>
  `;
}

export function buildScrollImageHtml(page) {
  return `
    <div class="reader-scroll-item" id="reader-scroll-page-${page.index}" data-page-index="${page.index}">
      <p class="reader-scroll-meta">Página ${page.index}</p>
      <img class="reader-scroll-image" src="${placeholderSrc}" data-src="${page.url}" alt="Página ${page.index}" loading="lazy" draggable="false" />
    </div>
  `;
}

export function attachReaderLazyImages(root) {
  const loader = createLazyImageLoader({
    root,
    rootMargin: '900px 0px',
    threshold: 0.01
  });

  loader.observe(root);
  return () => loader.disconnect();
}

export function preloadImage(url) {
  const nextUrl = String(url || '').trim();
  if (!nextUrl) return;

  const img = new Image();
  img.decoding = 'async';
  img.loading = 'eager';
  img.src = nextUrl;
}
