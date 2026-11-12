import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { session } from './browser.js';
import { TtlCache, Limiter, cached, prefetch } from './cache.js';
import {
  normalizeParams,
  normalizeReviewParams,
  normalizeCategoryParams,
  normalizeCompanyParams,
  buildPath,
  buildCategoryPath,
  buildCompanyPath,
  parseSearchPage,
  parseCategoryPage,
  parseCompanyPage,
  domainFrom,
  TRUST_SCORES,
  REVIEW_COUNTS,
  CATEGORY_SORTS,
  REVIEW_STARS,
  REVIEW_LANGUAGES,
  REVIEW_SORTS,
  COUNTRIES,
  CATEGORIES,
} from './trustpilot.js';
import { ReviewScans, parseReviewSearch } from './reviews.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.disable('x-powered-by');

const cache = new TtlCache({ ttlMs: CONFIG.cacheTtlMs, maxEntries: CONFIG.cacheMaxEntries });
const reviewCache = new TtlCache({
  ttlMs: CONFIG.reviewCacheTtlMs,
  maxEntries: CONFIG.reviewCacheMax,
});
/** Mode retenu (sémantique ou mots-clés) par recherche, pour une pagination stable. */
const plans = new TtlCache({ ttlMs: CONFIG.cacheTtlMs, maxEntries: CONFIG.cacheMaxEntries });
const limiter = new Limiter(CONFIG.maxConcurrency);

/**
 * Télécharge et lit une page. Une page sans données (challenge servi en 200,
 * page tronquée) relance une fois la session avant d'abandonner.
 */
async function fetchParsed(pathname, parse) {
  const html = await session.fetchHtml(pathname);
  try {
    return parse(html);
  } catch (err) {
    if (!err.retryable) throw err;
    console.warn('[parse] page inattendue, nouvelle session:', pathname);
    await session.resetAuth();
    return parse(await session.fetchHtml(pathname));
  }
}

/** Charge une page (cache + single-flight). */
async function load(store, pathname, parse) {
  const { value, hit, shared } = await cached(store, limiter, pathname, () => fetchParsed(pathname, parse));
  return { payload: value, hit, shared };
}

const cacheState = (loaded) => (loaded.hit ? 'hit' : loaded.shared ? 'shared' : 'miss');

/** En dessous de ce nombre de résultats, la recherche sémantique est comparée aux mots-clés. */
const SEMANTIC_MIN_RESULTS = 50;

/**
 * Choisit entre recherche sémantique et recherche par mots-clés.
 * La sémantique ramène parfois une poignée de résultats là où les mots-clés
 * en trouvent des centaines (« boulangerie paris » : 5 contre 1 095).
 */
async function searchPlan(params) {
  const first = { ...params, page: 1 };
  const key = buildPath(first, { semantic: false });
  const known = plans.get(key);
  if (known) return known;

  const semantic = await load(cache, buildPath(first), parseSearchPage);
  let plan = { semantic: true };
  const total = semantic.payload.pagination.totalResults;
  if (semantic.payload.source.searchMode !== 'domain' && total < SEMANTIC_MIN_RESULTS) {
    try {
      const keyword = await load(cache, key, parseSearchPage);
      if (keyword.payload.pagination.totalResults > total) plan = { semantic: false };
    } catch {
      /* les mots-clés ont échoué : on garde la sémantique */
    }
  }
  plans.set(key, plan);
  return plan;
}

/** Page de résultats d'entreprises, dans le mode retenu pour cette recherche. */
async function loadSearch(params) {
  const plan = await searchPlan(params);
  const pathname = buildPath(params, plan);
  return { ...(await load(cache, pathname, parseSearchPage)), plan };
}

const scans = new ReviewScans(
  (params) => loadSearch(params),
  async (pathname) => (await load(reviewCache, pathname, parseReviewSearch)).payload
);

/** Préchauffe la page suivante (une seule requête, non bloquante). */
function prefetchNext(pathname, parse) {
  setImmediate(() => prefetch(cache, limiter, pathname, () => fetchParsed(pathname, parse)));
}

const errorStatus = (err) => (err.status && err.status >= 400 && err.status < 600 ? err.status : 500);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...session.status, cache: cache.size, uptime: process.uptime() });
});

app.get('/api/options', (req, res) => {
  res.json({
    stars: TRUST_SCORES,
    reviews: REVIEW_COUNTS,
    categorySorts: CATEGORY_SORTS,
    reviewStars: REVIEW_STARS,
    reviewLanguages: REVIEW_LANGUAGES,
    reviewSorts: REVIEW_SORTS,
    countries: COUNTRIES,
    categories: CATEGORIES,
    maxPage: 1000,
  });
});

app.get('/api/_debug/expire', async (req, res) => {
  const cookies = await session.page?.cookies().catch(() => []) ?? [];
  for (const c of cookies.filter((x) => x.name === 'aws-waf-token')) {
    await session.page.deleteCookie({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
  }
  session.tokenAt = 0;
  res.json({ ok: true, ...session.status });
});

app.get('/api/search', async (req, res) => {
  let params;
  try {
    params = normalizeParams(new URLSearchParams(req.query));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  if (!params.query) {
    return res.json({
      params,
      items: [],
      pagination: { page: 1, pageSize: 10, totalPages: 0, totalResults: 0, hasNext: false, hasPrevious: false },
      cache: 'miss',
      empty: true,
    });
  }

  try {
    let loaded = await loadSearch(params);
    const lastPage = loaded.payload.pagination.totalPages;
    const page = Math.min(params.page, Math.max(lastPage, 1));

    // Page demandée au-delà du total : on récupère la dernière réelle.
    if (page !== params.page) loaded = await loadSearch({ ...params, page });
    const final = loaded.payload;

    if (final.pagination.hasNext) {
      prefetchNext(buildPath({ ...params, page: page + 1 }, loaded.plan), parseSearchPage);
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      params: { ...params, page },
      items: final.items,
      pagination: final.pagination,
      source: { ...final.source, semantic: loaded.plan.semantic },
      cache: cacheState(loaded),
    });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message || 'Erreur inattendue' });
  }
});

app.get('/api/category', async (req, res) => {
  let params;
  try {
    params = normalizeCategoryParams(new URLSearchParams(req.query));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    let loaded = await load(cache, buildCategoryPath(params), parseCategoryPage);
    const lastPage = loaded.payload.pagination.totalPages;
    const page = Math.min(params.page, Math.max(lastPage, 1));
    if (page !== params.page) {
      loaded = await load(cache, buildCategoryPath({ ...params, page }), parseCategoryPage);
    }
    const final = loaded.payload;
    // Trustpilot renvoie la page demandée même au-delà du total : on s'aligne sur la réelle.
    final.pagination = { ...final.pagination, page, hasNext: page < lastPage, hasPrevious: page > 1 };

    if (final.pagination.hasNext) {
      prefetchNext(buildCategoryPath({ ...params, page: page + 1 }), parseCategoryPage);
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      params: { ...params, page },
      items: final.items,
      pagination: final.pagination,
      category: final.category,
      cache: cacheState(loaded),
    });
  } catch (err) {
    const status = errorStatus(err);
    res.status(status).json({
      error: status === 404 ? 'Ce secteur n’existe pas (ou plus) sur Trustpilot' : err.message || 'Erreur inattendue',
    });
  }
});

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * Retrouve l'entreprise visée par son nom : recherche par mots-clés (plus
 * prévisible que la sémantique pour un nom propre), nom identique en priorité.
 * Renvoie aussi les autres candidats.
 */
async function resolveCompany(name) {
  const params = { query: name, trustscore: '', numberOfReviews: '', location: '', page: 1 };
  const { payload } = await load(cache, buildPath(params, { semantic: false }), parseSearchPage);
  const items = payload.items;
  if (!items.length) {
    const err = new Error(`Aucune entreprise trouvée pour « ${name} »`);
    err.status = 404;
    throw err;
  }
  const wanted = fold(name);
  const chosen = items.find((b) => fold(b.name) === wanted) ?? items[0];
  return {
    domain: chosen.domain,
    alternatives: items.filter((b) => b !== chosen).slice(0, 5),
  };
}

/** Fiche d'un domaine saisi : tel quel, puis avec « www. ». null si Trustpilot ne la connaît pas. */
async function loadDomain(domain, params) {
  const candidates = domain.startsWith('www.') ? [domain] : [domain, `www.${domain}`];
  for (const candidate of candidates) {
    try {
      return await load(reviewCache, buildCompanyPath(candidate, params), parseCompanyPage);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return null;
}

app.get('/api/company', async (req, res) => {
  let params;
  try {
    params = normalizeCompanyParams(new URLSearchParams(req.query));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    let resolved;
    let loaded;
    const domain = domainFrom(params.company);
    if (domain) {
      loaded = await loadDomain(domain, params);
      if (!loaded) {
        const err = new Error(`Aucune fiche Trustpilot pour ${domain}`);
        err.status = 404;
        throw err;
      }
      resolved = { domain: loaded.payload.business.domain, alternatives: [] };
    } else {
      resolved = await resolveCompany(params.company);
      loaded = await load(reviewCache, buildCompanyPath(resolved.domain, params), parseCompanyPage);
    }

    const lastPage = loaded.payload.pagination.totalPages;
    const page = Math.min(params.page, Math.max(lastPage, 1));
    if (page !== params.page) {
      loaded = await load(reviewCache, buildCompanyPath(resolved.domain, { ...params, page }), parseCompanyPage);
    }
    const final = loaded.payload;
    final.pagination = { ...final.pagination, page, hasNext: page < lastPage, hasPrevious: page > 1 };

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      params: { ...params, page },
      business: final.business,
      alternatives: resolved.alternatives,
      items: final.reviews,
      pagination: final.pagination,
      cache: cacheState(loaded),
    });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message || 'Erreur inattendue' });
  }
});

app.get('/api/review-search', async (req, res) => {
  let params;
  try {
    params = normalizeReviewParams(new URLSearchParams(req.query));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const perPage = CONFIG.reviewPerPage;
  const fresh = !scans.peek(params);

  try {
    const state = await scans.ensure(params, params.page * perPage + 1);

    // Page au-delà des résultats disponibles : on retombe sur la dernière utile.
    const lastUseful = Math.max(1, Math.ceil(state.hits.length / perPage));
    const page = Math.min(params.page, lastUseful);
    const offset = (page - 1) * perPage;

    const items = state.hits.slice(offset, offset + perPage);
    const more = !state.exhausted && !state.capped;
    const hasNext = state.hits.length > offset + perPage || more;

    res.set('Cache-Control', 'no-store');
    res.json({
      params: { ...params, page },
      items,
      pagination: {
        page,
        perPage,
        found: state.hits.length,
        scannedBusinesses: Math.min(state.scannedPages * 10, state.totalBusinesses ?? Infinity),
        totalBusinesses: state.totalBusinesses,
        hasNext,
        hasPrevious: page > 1,
        exhausted: state.exhausted,
        partial: state.partial && more,
      },
      cache: fresh ? 'miss' : 'shared',
    });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: err.message || 'Erreur inattendue' });
  }
});

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Trustpilot Scout sur http://${CONFIG.host}:${CONFIG.port}`);
});

async function shutdown() {
  server.close();
  await session.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
