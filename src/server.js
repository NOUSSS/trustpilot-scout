import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { session } from './browser.js';
import { TtlCache, Limiter, cached, prefetch } from './cache.js';
import {
  normalizeFindParams,
  needsServerFilter,
  searchSource,
  categorySource,
  companyReviewParams,
  scanReviewParams,
  buildPath,
  buildCategoryPath,
  buildCompanyPath,
  parseSearchPage,
  parseCategoryPage,
  parseCompanyPage,
  TRUST_SCORES,
  REVIEW_COUNTS,
  REVIEW_STARS,
  REVIEW_LANGUAGES,
  SORTS,
  COUNTRIES,
  CATEGORIES,
} from './trustpilot.js';
import { Collector, reviewMatches } from './reviews.js';

/** Pages de résultats maximum d'une collecte filtrée par le serveur. */
const MAX_SCAN_PAGE = 50;

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
  const { html, generation } = await session.fetchPage(pathname);
  try {
    return parse(html);
  } catch (err) {
    if (!err.retryable) throw err;
    console.warn('[parse] page inattendue, nouvelle session:', pathname);
    await session.resetAuth(generation);
    return parse((await session.fetchPage(pathname)).html);
  }
}

/** Clé de cache : le parseur et le chemin de la page. */
const cacheKey = (pathname, parse) => `${parse.name} ${pathname}`;

/** Charge une page (cache + single-flight). */
async function load(store, pathname, parse) {
  const { value, hit, shared } = await cached(store, limiter, cacheKey(pathname, parse), () =>
    fetchParsed(pathname, parse)
  );
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

const collector = new Collector();

/** Préchauffe la page suivante (une seule requête, non bloquante). */
function prefetchNext(pathname, parse) {
  setImmediate(() => prefetch(cache, limiter, cacheKey(pathname, parse), () => fetchParsed(pathname, parse)));
}

const errorStatus = (err) => (err.status && err.status >= 400 && err.status < 600 ? err.status : 500);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...session.status, cache: cache.size, uptime: process.uptime() });
});

app.get('/api/options', (req, res) => {
  res.json({
    stars: TRUST_SCORES,
    reviews: REVIEW_COUNTS,
    reviewStars: REVIEW_STARS,
    reviewLanguages: REVIEW_LANGUAGES,
    sorts: SORTS,
    countries: COUNTRIES,
    categories: CATEGORIES,
    maxPage: 1000,
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.get('/api/_debug/expire', async (req, res) => {
    const cookies = await session.page?.cookies().catch(() => []) ?? [];
    for (const c of cookies.filter((x) => x.name === 'aws-waf-token')) {
      await session.page.deleteCookie({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
    }
    session.tokenAt = 0;
    res.json({ ok: true, ...session.status });
  });
}

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

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

/** Page `n` de la source d'entreprises : le secteur s'il est choisi, sinon la recherche. */
async function loadSource(p, page) {
  if (p.category) {
    return (await load(cache, buildCategoryPath({ ...categorySource(p), page }), parseCategoryPage)).payload;
  }
  return (await loadSearch({ ...searchSource(p), page })).payload;
}

/** Filtre appliqué par le serveur quand Trustpilot ne sait pas le faire (secteur). */
function keepFor(p) {
  if (!needsServerFilter(p)) return () => true;
  const needle = fold(p.q);
  const minReviews = Number(p.numberOfReviews || 0);
  return (b) =>
    b.reviews >= minReviews && (!needle || fold(b.name).includes(needle) || fold(b.domain).includes(needle));
}

/** Avis d'une entreprise (saisie = domaine ou URL), avec tous les filtres d'avis. */
async function findCompany(p) {
  const params = companyReviewParams(p);
  let loaded = await loadDomain(p.domain, params);
  if (!loaded) {
    const err = new Error(`Aucune fiche Trustpilot pour ${p.domain}`);
    err.status = 404;
    throw err;
  }
  const domain = loaded.payload.business.domain;
  const lastPage = loaded.payload.pagination.totalPages;
  const page = Math.min(p.page, Math.max(lastPage, 1));
  if (page !== p.page) {
    loaded = await load(reviewCache, buildCompanyPath(domain, { ...params, page }), parseCompanyPage);
  }
  const final = loaded.payload;
  return {
    kind: 'company',
    params: { ...p, page },
    business: final.business,
    items: final.reviews,
    pagination: { ...final.pagination, page, hasNext: page < lastPage, hasPrevious: page > 1 },
    cache: cacheState(loaded),
  };
}

/** Liste directe : Trustpilot applique tous les filtres, sa pagination fait foi. */
async function findList(p) {
  const fromCategory = Boolean(p.category);
  const loadPage = (page) =>
    fromCategory
      ? load(cache, buildCategoryPath({ ...categorySource(p), page }), parseCategoryPage)
      : loadSearch({ ...searchSource(p), page });

  let loaded = await loadPage(p.page);
  const lastPage = loaded.payload.pagination.totalPages;
  const page = Math.min(p.page, Math.max(lastPage, 1));
  // Page demandée au-delà du total : on récupère la dernière réelle.
  if (page !== p.page) loaded = await loadPage(page);
  const final = loaded.payload;
  // Trustpilot renvoie la page demandée même au-delà du total : on s'aligne sur la réelle.
  const pagination = { ...final.pagination, page, hasNext: page < lastPage, hasPrevious: page > 1 };
  if (pagination.hasNext) {
    if (fromCategory) prefetchNext(buildCategoryPath({ ...categorySource(p), page: page + 1 }), parseCategoryPage);
    else prefetchNext(buildPath({ ...searchSource(p), page: page + 1 }, loaded.plan), parseSearchPage);
  }

  return {
    kind: 'list',
    params: { ...p, page },
    items: final.items,
    pagination,
    cache: cacheState(loaded),
  };
}

/**
 * Collecte filtrée par le serveur : fouille des avis (`scan`) ou filtre
 * d'appoint sur un secteur (`list`). Pagination propre, sur ce qui a été trouvé.
 */
async function findCollected(p) {
  const scan = p.kind === 'scan';
  const perPage = scan ? CONFIG.reviewPerPage : 20;
  const job = {
    loadPage: (page) => loadSource(p, page),
    keep: (() => {
      const keep = keepFor(p);
      return scan ? (b) => b.reviews > 0 && keep(b) : keep;
    })(),
    enrich: scan
      ? async (business) => {
          // Même page que la fiche de l'entreprise : l'ouvrir ensuite sort du cache.
          const path = buildCompanyPath(business.domain, scanReviewParams(p));
          const { total, matches } = reviewMatches((await load(reviewCache, path, parseCompanyPage)).payload);
          return total ? { ...business, matchCount: total, snippets: matches } : null;
        }
      : null,
  };
  const key = JSON.stringify([
    p.kind, p.q, p.category, p.country, p.city, p.trustscore, p.numberOfReviews,
    p.category ? p.sort : '', p.term, p.rating, p.language,
  ]);
  const fresh = !collector.peek(key);
  const page = Math.min(p.page, MAX_SCAN_PAGE);
  const state = await collector.ensure(key, job, page * perPage + 1);

  // Page au-delà des résultats disponibles : on retombe sur la dernière utile.
  const lastUseful = Math.max(1, Math.ceil(state.hits.length / perPage));
  const current = Math.min(page, lastUseful);
  const offset = (current - 1) * perPage;
  // Des entreprises en attente (avis illisibles pour l'instant) : relancer peut encore en trouver.
  const more = (!state.exhausted && !state.capped) || state.pending.length > 0;

  return {
    kind: p.kind,
    collected: true,
    params: { ...p, page: current },
    items: state.hits.slice(offset, offset + perPage),
    pagination: {
      page: current,
      perPage,
      found: state.hits.length,
      scannedBusinesses: state.scannedItems,
      totalBusinesses: state.totalSource,
      hasNext: state.hits.length > offset + perPage || (more && current < MAX_SCAN_PAGE),
      hasPrevious: current > 1,
      exhausted: state.exhausted,
      partial: state.partial && more,
    },
    cache: fresh ? 'miss' : 'shared',
  };
}

app.get('/api/find', async (req, res) => {
  let params;
  try {
    params = normalizeFindParams(new URLSearchParams(req.query));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    let body;
    if (params.kind === 'company') body = await findCompany(params);
    else if (params.kind === 'scan' || needsServerFilter(params)) body = await findCollected(params);
    else body = await findList(params);
    res.set('Cache-Control', body.collected ? 'no-store' : 'public, max-age=60');
    res.json(body);
  } catch (err) {
    const status = errorStatus(err);
    res.status(status).json({
      error:
        status === 404 && params.category && params.kind !== 'company'
          ? 'Ce secteur n’existe pas (ou plus) sur Trustpilot'
          : err.message || 'Erreur inattendue',
    });
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
