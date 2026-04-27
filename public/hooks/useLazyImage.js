const BLUR_PLACEHOLDER_DATA_URI =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iOTYiIHZpZXdCb3g9IjAgMCA2NCA5NiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjY0IiB5Mj0iOTYiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj48c3RvcCBzdG9wLWNvbG9yPSIjMTEyMDM0Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMGQxODJhIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9Ijk2IiBmaWxsPSJ1cmwoI2cpIi8+PC9zdmc+';

function loadImage(el) {
  if (!el || el.dataset.lazyLoaded === '1') return;

  const nextSrc = String(el.dataset.src || '').trim();
  if (!nextSrc) return;

  el.classList.add('lazy-image-loading');
  el.src = nextSrc;

  el.addEventListener(
    'load',
    () => {
      el.dataset.lazyLoaded = '1';
      el.classList.remove('lazy-image-loading');
      el.classList.add('lazy-image-loaded');
    },
    { once: true }
  );

  el.addEventListener(
    'error',
    () => {
      el.classList.remove('lazy-image-loading');
      el.classList.add('lazy-image-error');
    },
    { once: true }
  );
}

export function getBlurPlaceholderDataUri() {
  return BLUR_PLACEHOLDER_DATA_URI;
}

export function createLazyImageLoader(options = {}) {
  const rootMargin = options.rootMargin || '350px 0px';
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.01;
  const root = options.root || null;

  const observer =
    typeof window !== 'undefined' && 'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              loadImage(entry.target);
              observer.unobserve(entry.target);
            });
          },
          { root, rootMargin, threshold }
        )
      : null;

  function observe(target) {
    if (!target) return;

    const nodes =
      target instanceof Element
        ? target.querySelectorAll('img[data-src]')
        : target instanceof NodeList || Array.isArray(target)
          ? target
          : document.querySelectorAll('img[data-src]');

    Array.from(nodes).forEach((node) => {
      if (!node || node.dataset.lazyLoaded === '1') return;
      if (!node.getAttribute('src')) {
        node.setAttribute('src', BLUR_PLACEHOLDER_DATA_URI);
      }
      node.classList.add('lazy-image');

      if (!observer) {
        loadImage(node);
        return;
      }

      observer.observe(node);
    });
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
    }
  }

  return {
    observe,
    disconnect
  };
}
