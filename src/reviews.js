import { CONFIG } from './config.js';
import { pageProps } from './trustpilot.js';

/** Échappe une valeur pour l'insérer dans un chemin d'URL Trustpilot. */
export function reviewSearchPath(domain, term) {
  const qs = new URLSearchParams({
    search: term,
    languages: 'all',
    sort: 'relevance',
  });
  return `/review/${encodeURIComponent(domain)}?${qs.toString()}`;
}

/**
 * Lit une page de recherche d'avis : nombre total de correspondances + extraits.
 * Le texte renvoyé contient les balises <em> de surlignage de Trustpilot.
 */
export function parseReviewSearch(html) {
  const props = pageProps(html);

  const total = Number(props?.filters?.pagination?.totalCount ?? 0);
  if (!total) return { total: 0, matches: [] };

  const matches = (props.reviews ?? []).slice(0, CONFIG.reviewSnippets).map((r) => ({
    id: r.id,
    text: (r.text ?? '').slice(0, 320),
    title: r.title ?? '',
    rating: Number(r.rating ?? 0),
    author: r.consumer?.displayName ?? 'Anonyme',
    country: r.consumer?.countryCode ?? '',
    language: r.language ?? '',
    date: r.dates?.publishedDate ?? r.dates?.experiencedDate ?? null,
    url: `https://www.trustpilot.com/reviews/${r.id}`,
  }));

  return { total, matches };
}

/**
 * Scanner incrémental : avance dans les pages de résultats d'entreprises,
 * interroge les avis de chaque entreprise et accumule les correspondances.
 * L'état est partagé entre requêtes identiques (une seule exploration).
 */
export class ReviewScans {
  /**
   * @param {(params) => Promise<{payload}>} loadBusinessPage page de résultats d'entreprises
   * @param {(path: string) => Promise<{total, matches}>} loadReviewSearch avis filtrés (avec cache)
   */
  constructor(loadBusinessPage, loadReviewSearch) {
    this.loadBusinessPage = loadBusinessPage;
    this.loadReviewSearch = loadReviewSearch;
    this.states = new Map();
  }

  key(criteria) {
    return [criteria.query, criteria.trustscore, criteria.numberOfReviews, criteria.location].join('\u0001');
  }

  state(criteria) {
    const key = this.key(criteria);
    let state = this.states.get(key);
    if (state && !state.running && Date.now() - state.updatedAt > CONFIG.reviewStateTtlMs) {
      this.states.delete(key);
      state = null;
    }
    if (state) {
      state.updatedAt = Date.now();
      return state;
    }
    state = {
      key,
      hits: [],
      seen: new Set(),
      scannedPages: 0,
      exhausted: false,
      partial: false,
      capped: false,
      error: null,
      totalBusinesses: null,
      updatedAt: Date.now(),
      running: null,
    };
    this.states.set(key, state);
    this.prune();
    return state;
  }

  prune() {
    if (this.states.size <= CONFIG.reviewStateMax) return;
    const sorted = [...this.states.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const state of sorted.slice(0, this.states.size - CONFIG.reviewStateMax)) {
      this.states.delete(state.key);
    }
  }

  /** Traite une page de résultats d'entreprises. */
  async scanOnePage(state, criteria) {
    const pageNumber = state.scannedPages + 1;
    const { payload } = await this.loadBusinessPage({ ...criteria, page: pageNumber });

    state.scannedPages = pageNumber;
    if (state.totalBusinesses == null) state.totalBusinesses = payload.pagination.totalResults;
    if (!payload.items.length || pageNumber >= payload.pagination.totalPages) state.exhausted = true;

    const targets = payload.items.filter((b) => b.reviews > 0 && !state.seen.has(b.domain));
    for (const b of targets) state.seen.add(b.domain);

    // L'ordre de poussée suit l'ordre des entreprises pour une pagination stable.
    const results = await Promise.all(
      targets.map(async (business) => {
        try {
          const value = await this.loadReviewSearch(reviewSearchPath(business.domain, criteria.query));
          return value.total ? { business, ...value } : null;
        } catch {
          return null;
        }
      })
    );

    for (const hit of results) {
      if (!hit) continue;
      state.hits.push({
        ...hit.business,
        matchCount: hit.total,
        snippets: hit.matches,
      });
    }
  }

  /**
   * Explore jusqu'à disposer de `needed` résultats (borné par le budget).
   * Un scan arrêté par le budget reprend là où il s'était arrêté au prochain appel ;
   * seul le plafond de pages est définitif.
   */
  async ensure(criteria, needed) {
    const state = this.state(criteria);
    if (state.running) {
      await state.running.catch(() => {});
      return state;
    }
    if (state.hits.length >= needed || state.exhausted || state.capped) return state;

    state.partial = false;
    state.error = null;
    state.running = (async () => {
      const started = Date.now();
      while (
        state.hits.length < needed &&
        !state.exhausted &&
        state.scannedPages < CONFIG.reviewMaxScanPages &&
        state.hits.length < CONFIG.reviewMaxHits
      ) {
        if (Date.now() - started > CONFIG.reviewScanBudgetMs) {
          state.partial = true;
          break;
        }
        await this.scanOnePage(state, criteria);
      }
      if (
        !state.exhausted &&
        (state.scannedPages >= CONFIG.reviewMaxScanPages || state.hits.length >= CONFIG.reviewMaxHits)
      ) {
        state.capped = true;
        state.partial = true;
      }
    })();
    state.running
      .catch((err) => {
        // Page d'entreprises introuvable : on garde ce qui a été trouvé, la suite se relance.
        state.error = err;
        state.partial = true;
      })
      .finally(() => {
        state.running = null;
      });

    await state.running.catch(() => {});
    if (state.error && !state.hits.length) throw state.error;
    return state;
  }

  /** État public pour une clé donnée (sans lancer de scan). */
  peek(criteria) {
    return this.states.get(this.key(criteria)) ?? null;
  }
}
