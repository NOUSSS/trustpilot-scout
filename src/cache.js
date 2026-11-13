/** Cache LRU avec TTL + déduplication des requêtes en vol. */
export class TtlCache {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Rafraîchit l'ordre LRU.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/**
 * Limite le nombre d'exécutions simultanées. Les tâches de fond (parcours,
 * fouille des avis) passent après les autres : une fouille ne fait pas
 * attendre une recherche simple.
 */
export class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
    this.background = [];
  }

  async run(task, { background = false } = {}) {
    if (this.active >= this.max) {
      await new Promise((resolve) => (background ? this.background : this.waiting).push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.waiting.shift() ?? this.background.shift();
      if (next) next();
    }
  }
}

/**
 * Enveloppe une fonction async avec cache + single-flight.
 * @param {TtlCache} cache
 * @param {Limiter} limiter
 * @param {() => Promise<any>} task
 * @param {string} key
 * @param {{ background?: boolean }} [options] transmis au limiteur
 */
export async function cached(cache, limiter, key, task, options) {
  const hit = cache.get(key);
  if (hit !== undefined) return { value: hit, hit: true, shared: false };

  let inflight = cache.inflight?.get(key);
  const joined = Boolean(inflight);
  if (!inflight) {
    if (!cache.inflight) cache.inflight = new Map();
    inflight = limiter
      .run(task, options)
      .then((value) => {
        cache.set(key, value);
        return value;
      })
      .finally(() => cache.inflight.delete(key));
    cache.inflight.set(key, inflight);
  }
  return { value: await inflight, hit: false, shared: joined };
}

/** Préchauffe une clé sans attendre. */
export function prefetch(cache, limiter, key, task) {
  if (cache.get(key) !== undefined) return;
  if (cache.inflight?.has(key)) return;
  cached(cache, limiter, key, task).catch(() => {});
}
