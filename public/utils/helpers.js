export function debounceWithTimer(previousTimer, delayMs, callback) {
  clearTimeout(previousTimer);
  return setTimeout(callback, delayMs);
}

export function createTtlCache(maxEntries = 50, ttlMs = 5 * 60 * 1000) {
  const cache = new Map();
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) return null;
      if (Date.now() - entry.createdAt > ttlMs) {
        cache.delete(key);
        return null;
      }
      return entry.data;
    },
    set(key, data) {
      if (cache.size >= maxEntries) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of cache.entries()) {
          if (v.createdAt < oldestTime) {
            oldestTime = v.createdAt;
            oldestKey = k;
          }
        }
        if (oldestKey) cache.delete(oldestKey);
      }
      cache.set(key, { data, createdAt: Date.now() });
    },
    has(key) {
      return this.get(key) !== null;
    },
    clear() {
      cache.clear();
    },
    delete(key) {
      cache.delete(key);
    }
  };
}
