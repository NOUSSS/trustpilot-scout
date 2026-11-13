import { CONFIG } from './config.js';
import { pageProps } from './trustpilot.js';

/**
 * Avis d'une entreprise filtrés par texte, note et langue. Avec un texte,
 * Trustpilot entoure les correspondances de <em> et trie par pertinence.
 */
export function reviewFilterPath(domain, { term, rating, language }) {
  const qs = new URLSearchParams({ languages: language || 'all' });
  if (term) qs.set('search', term);
  if (rating) qs.set('stars', rating);
  qs.set('sort', term ? 'relevance' : 'recency');
  return `/review/${encodeURIComponent(domain)}?${qs.toString()}`;
}

/**
 * Lit une page d'avis filtrés : nombre total de correspondances + extraits.
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

/** Essais d'interrogation des avis d'une entreprise avant de l'abandonner. */
const MAX_ENRICH_TRIES = 3;

/** Erreur définitive (fiche absente, refus) : réessayer ne changerait rien. */
const isPermanent = (err) => err.status >= 400 && err.status < 500 && err.status !== 429;

/**
 * Collecteur incrémental : avance dans les pages d'une source d'entreprises
 * (recherche ou secteur), garde celles qui passent le filtre, puis, si besoin,
 * interroge leurs avis et ne retient que celles qui ont une correspondance.
 * L'état est partagé entre requêtes identiques (une seule exploration).
 *
 * Un travail (`job`) fournit :
 * - `loadPage(n)` → `{ items, pagination }` de la source ;
 * - `keep(business)` → booléen, filtre appliqué par le serveur ;
 * - `enrich(business)` (facultatif) → résultat ou null si rien ne correspond.
 */
export class Collector {
  constructor() {
    this.states = new Map();
  }

  state(key) {
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
      /** Entreprises dont les avis n'ont pas pu être lus : `{ business, tries }`, réessayées au prochain appel. */
      pending: [],
      seen: new Set(),
      scannedPages: 0,
      scannedItems: 0,
      exhausted: false,
      partial: false,
      capped: false,
      error: null,
      totalSource: null,
      updatedAt: Date.now(),
      running: null,
    };
    this.states.set(key, state);
    this.prune();
    return state;
  }

  prune() {
    if (this.states.size <= CONFIG.reviewStateMax) return;
    const idle = [...this.states.values()].filter((s) => !s.running).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const state of idle.slice(0, this.states.size - CONFIG.reviewStateMax)) {
      this.states.delete(state.key);
    }
  }

  /** Traite une page de la source. */
  async scanOnePage(state, job) {
    const pageNumber = state.scannedPages + 1;
    const payload = await job.loadPage(pageNumber);

    state.scannedPages = pageNumber;
    state.scannedItems += payload.items.length;
    if (state.totalSource == null) state.totalSource = payload.pagination.totalResults;
    if (!payload.items.length || pageNumber >= payload.pagination.totalPages) state.exhausted = true;

    const targets = payload.items.filter((b) => !state.seen.has(b.domain) && job.keep(b));
    for (const b of targets) state.seen.add(b.domain);

    // L'ordre de poussée suit l'ordre de la source pour une pagination stable.
    if (!job.enrich) state.hits.push(...targets);
    else await this.enrichAll(state, job, targets.map((business) => ({ business, tries: 0 })));
  }

  /**
   * Interroge les avis de chaque entreprise. Un échec passager n'est pas une
   * absence de correspondance : l'entreprise reste en attente pour le prochain appel.
   */
  async enrichAll(state, job, entries) {
    const results = await Promise.all(
      entries.map(async ({ business, tries }) => {
        try {
          return { hit: await job.enrich(business) };
        } catch (err) {
          if (isPermanent(err)) return { hit: null };
          if (tries + 1 >= MAX_ENRICH_TRIES) {
            console.warn('[scan] avis illisibles, entreprise abandonnée:', business.domain, err.message);
            return { hit: null };
          }
          return { retry: { business, tries: tries + 1 } };
        }
      })
    );
    for (const { hit, retry } of results) {
      if (retry) state.pending.push(retry);
      else if (hit) state.hits.push(hit);
    }
  }

  /**
   * Explore jusqu'à disposer de `needed` résultats (borné par le budget).
   * Un scan arrêté par le budget reprend là où il s'était arrêté au prochain appel ;
   * seul le plafond de pages est définitif.
   */
  async ensure(key, job, needed) {
    const state = this.state(key);
    // Un scan en cours visait peut-être moins de résultats : on attend sa fin, puis on complète.
    while (state.running) await state.running.catch(() => {});
    const sourceDone = state.exhausted || state.capped;
    if (!state.pending.length && (state.hits.length >= needed || sourceDone)) return state;

    state.partial = false;
    state.error = null;
    state.running = (async () => {
      const started = Date.now();
      if (state.pending.length) await this.enrichAll(state, job, state.pending.splice(0));
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
        await this.scanOnePage(state, job);
      }
      if (
        !state.exhausted &&
        (state.scannedPages >= CONFIG.reviewMaxScanPages || state.hits.length >= CONFIG.reviewMaxHits)
      ) {
        state.capped = true;
        state.partial = true;
      }
      if (state.pending.length) state.partial = true;
    })();
    state.running
      .catch((err) => {
        // Page de la source introuvable : on garde ce qui a été trouvé, la suite se relance.
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

  /** État pour une clé donnée (sans lancer de scan). */
  peek(key) {
    return this.states.get(key) ?? null;
  }
}
