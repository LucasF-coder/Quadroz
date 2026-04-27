function createTtlCache(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 300000);
  const maxEntries = Math.max(50, Number(options.maxEntries) || 500);

  const store = new Map();
  const inflight = new Map();

  function now() {
    return Date.now();
  }

  function isValid(entry) {
    return Boolean(entry) && entry.expiresAt > now();
  }

  function cleanup() {
    if (store.size <= maxEntries) return;

    const rows = Array.from(store.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const overflow = store.size - maxEntries;

    for (let index = 0; index < overflow; index += 1) {
      store.delete(rows[index][0]);
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

  function set(key, value, customTtlMs = ttlMs) {
    const ttl = Math.max(500, Number(customTtlMs) || ttlMs);
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

  async function wrap(key, factory, customTtlMs = ttlMs) {
    const cached = get(key);
    if (cached !== null) {
      return cached;
    }

    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const task = Promise.resolve()
      .then(factory)
      .then((value) => set(key, value, customTtlMs))
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

module.exports = {
  createTtlCache
};
