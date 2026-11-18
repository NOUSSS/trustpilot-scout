import { CONFIG } from './config.js';

/**
 * Résumé d'une page d'avis déjà lue par `parseCompanyPage` : nombre total de
 * correspondances + extraits. Le texte garde les balises <em> de surlignage de Trustpilot.
 */
export function reviewMatches(page) {
  const total = page.pagination.totalResults;
  if (!total) return { total: 0, matches: [] };

  const matches = page.reviews.slice(0, CONFIG.reviewSnippets).map((r) => ({
    id: r.id,
    text: r.text.slice(0, 320),
    title: r.title,
    rating: r.rating,
    author: r.author,
    country: r.country,
    language: r.language,
    date: r.date,
    url: r.url,
  }));

  return { total, matches };
}

/** Fiches lues d'un seul tenant : une page Trustpilot. */
const ENRICH_BATCH = 20;

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
 * - `enrich(business)` (facultatif) → résultat ou null si rien ne correspond ;
 * - `preload(n)` (facultatif) → préchauffe la page `n` de la source pendant la
 *   lecture des fiches de la page précédente, pour que `loadPage(n)` la trouve
 *   prête. Jamais attendu ; son échec est ignoré (`loadPage` relira la page).
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
      /** Entreprises d'une page pas encore lues (budget, départ du client) : `{ business, tries }`, lues avant la page suivante. */
      deferred: [],
      seen: new Set(),
      scannedPages: 0,
      /** Pages réellement lues : plusieurs par page de la source pour un continent. */
      sourcePages: 0,
      scannedItems: 0,
      /** Entreprises examinées : écartées par le filtre, ou dont la fiche est partie à la lecture. Ne fait que croître. */
      examined: 0,
      exhausted: false,
      partial: false,
      capped: false,
      error: null,
      totalSource: null,
      updatedAt: Date.now(),
      running: null,
      owner: null,
      /** Requêtes qui attendent encore ce parcours. */
      waiters: 0,
      /** Réveils des requêtes en attente : appelés à chaque résultat poussé et en fin de parcours. */
      wakers: new Set(),
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

  /**
   * Lit les fiches par lots d'une page Trustpilot. Entre deux lots, `stop()` (budget
   * dépassé, plus personne n'attend) remet le reste à plus tard, sans compter d'essai :
   * une page de continent en cumule des centaines.
   */
  async enrichBatches(state, job, entries, stop) {
    for (let i = 0; i < entries.length; i += ENRICH_BATCH) {
      if (i > 0 && stop()) {
        state.deferred.push(...entries.slice(i));
        return;
      }
      const batch = entries.slice(i, i + ENRICH_BATCH);
      for (const entry of batch) {
        if (entry.examined) continue;
        entry.examined = true;
        state.examined++;
      }
      await this.enrichAll(state, job, batch);
    }
  }

  /** Traite une page de la source. */
  async scanOnePage(state, job, stop = () => false) {
    const pageNumber = state.scannedPages + 1;
    const payload = await job.loadPage(pageNumber);

    state.scannedPages = pageNumber;
    state.sourcePages += payload.pagination.sourcePages ?? 1;
    state.scannedItems += payload.items.length;
    if (state.totalSource == null) state.totalSource = payload.pagination.totalResults;
    if (!payload.items.length || pageNumber >= payload.pagination.totalPages) state.exhausted = true;

    // Une même page peut citer deux fois une entreprise (deux pays d'un continent) : elle ne compte qu'une fois.
    const targets = payload.items.filter((b) => {
      if (state.seen.has(b.domain) || !job.keep(b)) return false;
      state.seen.add(b.domain);
      return true;
    });

    // L'ordre de poussée suit l'ordre de la source pour une pagination stable.
    if (!job.enrich) {
      state.examined += payload.items.length;
      state.hits.push(...targets);
      this.wake(state);
      return;
    }
    // La page suivante part avant les fiches, pour prendre son créneau en tête de
    // file : sinon le limiteur reste à moitié vide pendant sa lecture.
    if (
      job.preload &&
      targets.length &&
      !state.exhausted &&
      state.sourcePages < CONFIG.reviewMaxScanPages &&
      state.hits.length < CONFIG.reviewMaxHits
    ) {
      try {
        const preloading = job.preload(pageNumber + 1);
        if (typeof preloading?.catch === 'function') preloading.catch(() => {});
      } catch {
        /* simple préchauffage : `loadPage` relira la page */
      }
    }
    // Les entreprises écartées par le filtre sont examinées d'emblée ; les autres, à la lecture de leur fiche.
    state.examined += payload.items.length - targets.length;
    await this.enrichBatches(state, job, targets.map((business) => ({ business, tries: 0 })), stop);
  }

  /**
   * Interroge les avis de chaque entreprise. Un échec passager n'est pas une
   * absence de correspondance : l'entreprise reste en attente pour le prochain appel.
   * Les résultats sont poussés dès que toutes les fiches qui les précèdent sont lues :
   * une requête comblée n'attend pas la fin de la page, et l'ordre reste celui de la source.
   */
  async enrichAll(state, job, entries) {
    const outcomes = new Array(entries.length);
    let next = 0;
    await Promise.all(
      entries.map(async ({ business, tries }, i) => {
        try {
          outcomes[i] = { hit: await job.enrich(business) };
        } catch (err) {
          if (isPermanent(err)) outcomes[i] = { hit: null };
          else if (tries + 1 >= MAX_ENRICH_TRIES) {
            console.warn('[scan] avis illisibles, entreprise abandonnée:', business.domain, err.message);
            outcomes[i] = { hit: null };
          } else outcomes[i] = { retry: { business, tries: tries + 1, examined: true } };
        }
        if (i !== next) return;
        while (next < entries.length && outcomes[next]) {
          const { hit, retry } = outcomes[next++];
          if (retry) state.pending.push(retry);
          else if (hit) state.hits.push(hit);
        }
        this.wake(state);
      })
    );
  }

  /** Réveille les requêtes en attente pour qu'elles comparent les résultats à leur besoin. */
  wake(state) {
    for (const waker of [...state.wakers]) waker();
  }

  /**
   * Attend que le parcours en cours se termine, ou que `needed` résultats soient là.
   * Le réveil se retire de lui-même : rien ne reste accroché à l'état après le retour.
   */
  until(state, needed) {
    return new Promise((resolve) => {
      const waker = () => {
        if (state.running && state.hits.length < needed) return;
        state.wakers.delete(waker);
        resolve();
      };
      state.wakers.add(waker);
      waker();
    });
  }

  /**
   * Explore jusqu'à disposer de `needed` résultats (borné par le budget).
   * Un scan arrêté par le budget reprend là où il s'était arrêté au prochain appel ;
   * seul le plafond de pages est définitif.
   */
  async ensure(key, job, needed, { owner = null, signal = null } = {}) {
    const state = this.state(key);
    if (signal?.aborted) return state;
    // `signal` s'interrompt quand le client de la requête est parti : le parcours
    // que plus personne n'attend s'arrête et rend sa place.
    state.waiters++;
    const leave = () => {
      state.waiters--;
    };
    signal?.addEventListener('abort', leave, { once: true });
    try {
      return await this.advance(state, job, needed, owner, signal);
    } finally {
      signal?.removeEventListener('abort', leave);
      if (!signal?.aborted) leave();
    }
  }

  async advance(state, job, needed, owner, signal) {
    // Un scan en cours visait peut-être moins de résultats : on attend sa fin, puis on complète.
    // Résultats déjà là ou arrivés pendant l'attente (ils ne font que s'allonger) : la page
    // n'attend pas la fin du parcours, qui continue sans elle.
    while (state.running) {
      if (state.hits.length >= needed) return state;
      await this.until(state, needed);
    }
    if (signal?.aborted) return state;
    const sourceDone = state.exhausted || state.capped;
    // Fiches remises à plus tard : elles ne valent la peine d'être lues que sous le plafond.
    const unread = state.deferred.length > 0 && state.hits.length < CONFIG.reviewMaxHits;
    if (!state.pending.length && (state.hits.length >= needed || (sourceDone && !unread))) return state;

    this.admit(owner);
    state.owner = owner;
    state.partial = false;
    state.error = null;
    state.running = (async () => {
      const started = Date.now();
      // Budget dépassé, ou plus aucune requête n'attend : on s'arrête, la suite reprendra d'ici.
      const stop = () => Date.now() - started > CONFIG.reviewScanBudgetMs || !state.waiters;
      if (state.pending.length) await this.enrichBatches(state, job, state.pending.splice(0), stop);
      while (state.hits.length < needed && state.hits.length < CONFIG.reviewMaxHits) {
        if (stop()) {
          state.partial = true;
          break;
        }
        // La fin de la page en cours passe avant la page suivante : l'ordre reste celui de la source.
        if (state.deferred.length) {
          await this.enrichBatches(state, job, state.deferred.splice(0), stop);
          continue;
        }
        if (state.exhausted || state.sourcePages >= CONFIG.reviewMaxScanPages) break;
        await this.scanOnePage(state, job, stop);
      }
      if (
        !state.exhausted &&
        (state.sourcePages >= CONFIG.reviewMaxScanPages || state.hits.length >= CONFIG.reviewMaxHits)
      ) {
        state.capped = true;
        state.partial = true;
      }
      if (state.pending.length || state.deferred.length) state.partial = true;
    })();
    state.running
      .catch((err) => {
        // Page de la source introuvable : on garde ce qui a été trouvé, la suite se relance.
        state.error = err;
        state.partial = true;
      })
      .finally(() => {
        state.running = null;
        this.wake(state);
      });

    // Lancé pour réessayer les fiches en attente alors que les résultats suffisaient
    // déjà : on attend ces essais. Sinon on revient dès que `needed` est atteint.
    await this.until(state, state.hits.length >= needed ? Infinity : needed);
    if (state.error && !state.hits.length) throw state.error;
    return state;
  }

  /**
   * Refuse un nouveau parcours quand trop sont déjà en cours, au total ou pour ce client.
   * Un parcours abandonné (plus aucune requête ne l'attend) finit sa page en cours et
   * compte jusque-là pour son client : sinon un seul client remplirait toutes les
   * places en lançant puis en quittant des parcours. La page, elle, patiente.
   */
  admit(owner) {
    const running = [...this.states.values()].filter((s) => s.running);
    const mine = owner ? running.filter((s) => s.owner === owner).length : 0;
    if (running.length < CONFIG.maxActiveScans && mine < CONFIG.maxScansPerClient) return;
    const err = new Error(
      mine >= CONFIG.maxScansPerClient
        ? 'Tu as déjà des parcours en cours : attends qu’ils se terminent'
        : 'Trop de parcours en cours : réessaie dans quelques secondes'
    );
    err.status = mine >= CONFIG.maxScansPerClient ? 429 : 503;
    err.retryAfter = 5;
    throw err;
  }

  /** État pour une clé donnée (sans lancer de scan). */
  peek(key) {
    return this.states.get(key) ?? null;
  }
}
