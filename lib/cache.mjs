/**
 * Cache TTL + LRU + single-flight. Single-flight mencegah dua permintaan
 * identik menembak origin yang sama secara bersamaan.
 */
export function createCache({ ttlMs = 60_000, max = 100, clock = Date.now } = {}) {
  const entries = new Map();
  const inflight = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (clock() - entry.at >= ttlMs) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  function set(key, value) {
    entries.delete(key);
    entries.set(key, { value, at: clock() });
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return value;
  }

  async function resolve(key, producer) {
    const hit = get(key);
    if (hit) return { value: hit.value, cached: true, at: hit.at };
    if (inflight.has(key)) {
      const value = await inflight.get(key);
      return { value, cached: true, at: clock() };
    }
    const promise = Promise.resolve().then(producer);
    inflight.set(key, promise);
    try {
      const value = await promise;
      set(key, value);
      return { value, cached: false, at: clock() };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    get,
    set,
    resolve,
    size: () => entries.size,
    clear: () => { entries.clear(); inflight.clear(); }
  };
}
