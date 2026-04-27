export function createRequestCache(options = {}) {
  const defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs) || 12000);
  const maxEntries = Math.max(50, Number(options.maxEntries) || 300);
  const store = new Map();
  const inflight = new Map();

  function now() {
    return Date.now();
  }

  function isValid(entry) {
    if (!entry) return false;
    return entry.expiresAt > now();
  }

  function cleanup() {
    if (store.size <= maxEntries) return;

    const entries = Array.from(store.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const removeCount = Math.max(1, store.size - maxEntries);
    for (let index = 0; index < removeCount; index += 1) {
      store.delete(entries[index][0]);
    }
  }

  function get(key) {
    const entry = store.get(key);
    if (!isValid(entry)) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key, value, ttlMs = defaultTtlMs) {
    const ttl = Math.max(500, Number(ttlMs) || defaultTtlMs);
    store.set(key, {
      value,
      createdAt: now(),
      expiresAt: now() + ttl
    });
    cleanup();
    return value;
  }

  function remove(key) {
    store.delete(key);
    inflight.delete(key);
  }

  function clear() {
    store.clear();
    inflight.clear();
  }

  async function wrap(key, factory, ttlMs = defaultTtlMs) {
    const cached = get(key);
    if (cached !== null) {
      return cached;
    }

    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const task = Promise.resolve()
      .then(factory)
      .then((value) => set(key, value, ttlMs))
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, task);
    return task;
  }

  return {
    get,
    set,
    remove,
    clear,
    wrap
  };
}
