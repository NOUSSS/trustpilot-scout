/** Construction des recherches et lecture des résultats Trustpilot. */
import fs from 'node:fs';

export const TRUST_SCORES = [
  { value: '', label: 'Toutes les notes' },
  { value: '3.0', label: '3 étoiles et +' },
  { value: '4.0', label: '4 étoiles et +' },
  { value: '4.5', label: '4,5 étoiles et +' },
];

export const REVIEW_COUNTS = [
  { value: '', label: "Peu importe" },
  { value: '25', label: '25 avis et +' },
  { value: '50', label: '50 avis et +' },
  { value: '100', label: '100 avis et +' },
  { value: '250', label: '250 avis et +' },
  { value: '500', label: '500 avis et +' },
];

/** Tris proposés par les pages de catégories (les autres valeurs sont ignorées). */
export const CATEGORY_SORTS = [
  { value: 'most_relevant', label: 'Pertinence' },
  { value: 'reviews_count', label: 'Nombre d’avis' },
  { value: 'latest_review', label: 'Avis les plus récents' },
];

export const REVIEW_STARS = [
  { value: '', label: 'Toutes les notes' },
  { value: '5', label: '5 étoiles' },
  { value: '4', label: '4 étoiles' },
  { value: '3', label: '3 étoiles' },
  { value: '2', label: '2 étoiles' },
  { value: '1', label: '1 étoile' },
];

export const REVIEW_LANGUAGES = ['all', 'fr', 'en', 'de', 'es', 'it', 'nl', 'pt', 'da', 'sv', 'pl'];

export const REVIEW_SORTS = [
  { value: 'recency', label: 'Plus récents' },
  { value: 'relevance', label: 'Pertinence' },
];

/** Marchés principaux de Trustpilot (codes ISO, noms traduits côté client). */
export const COUNTRIES = [
  'FR', 'BE', 'CH', 'LU', 'CA', 'MA', 'TN', 'DZ', 'SN', 'CI',
  'US', 'GB', 'IE', 'DE', 'AT', 'NL', 'IT', 'ES', 'PT', 'DK', 'SE', 'NO', 'FI',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'EE', 'UA',
  'AU', 'NZ', 'ZA', 'JP', 'SG', 'HK', 'CN', 'BR',
];

/** Catégories (noms français relevés sur fr.trustpilot.com). */
export const CATEGORIES = JSON.parse(
  fs.readFileSync(new URL('./categories.fr.json', import.meta.url), 'utf8')
);

const TRUST_SET = new Set(TRUST_SCORES.map((o) => o.value).filter(Boolean));
const REVIEW_SET = new Set(REVIEW_COUNTS.map((o) => o.value).filter(Boolean));
const CATEGORY_SORT_SET = new Set(CATEGORY_SORTS.map((o) => o.value));
const REVIEW_STAR_SET = new Set(REVIEW_STARS.map((o) => o.value).filter(Boolean));
const REVIEW_LANG_SET = new Set(REVIEW_LANGUAGES);
const REVIEW_SORT_SET = new Set(REVIEW_SORTS.map((o) => o.value));
const COUNTRY_SET = new Set(COUNTRIES);
const CATEGORY_SET = new Set(CATEGORIES.flatMap((c) => [c.id, ...c.sub.map((s) => s.id)]));

const MAX_PAGE = 1000;
/** Au-delà de la 10e page d'avis, Trustpilot exige une connexion. */
const MAX_REVIEW_PAGE = 10;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Page Trustpilot sans les données attendues : souvent un challenge WAF servi en 200. */
export class UnexpectedPageError extends Error {
  constructor(message) {
    super(message);
    this.retryable = true;
  }
}

const clean = (value, max) =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max);

function readPage(searchParams, max) {
  let page = Number.parseInt(searchParams.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return Math.min(page, max);
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Domaine contenu dans une saisie (« https://www.fnac.com/x », « fnac.com »),
 * ou null si la saisie ressemble à un nom.
 */
export function domainFrom(input) {
  const raw = clean(input, 300);
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let host;
  try {
    // Gère aussi les domaines accentués (punycode) et les ports.
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').toLowerCase();
  if (!DOMAIN_RE.test(host) || !/\.[a-z]{2,}$/.test(host)) return null;
  return host;
}

/** Normalise et valide les paramètres entrants. */
export function normalizeParams(searchParams) {
  let query = clean(searchParams.get('q'), 120);
  // Une URL collée devient son domaine : Trustpilot ouvre alors directement la fiche.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) query = domainFrom(query) ?? query;
  const trustscore = clean(searchParams.get('stars'), 8);
  const numberOfReviews = clean(searchParams.get('reviews'), 8);
  const location = clean(searchParams.get('location'), 80);

  if (trustscore && !TRUST_SET.has(trustscore)) {
    throw new ValidationError(`Note invalide : ${trustscore}`);
  }
  if (numberOfReviews && !REVIEW_SET.has(numberOfReviews)) {
    throw new ValidationError(`Nombre d'avis invalide : ${numberOfReviews}`);
  }

  return { query, trustscore, numberOfReviews, location, page: readPage(searchParams, MAX_PAGE) };
}

/**
 * Chemin de recherche canonique (sert aussi de clé de cache).
 * `semantic` active la recherche sémantique expérimentale de Trustpilot,
 * plus tolérante aux formulations mais parfois très pauvre en résultats.
 */
export function buildPath(params, { semantic = true } = {}) {
  const qs = new URLSearchParams();
  qs.set('query', params.query);
  if (params.trustscore) qs.set('trustscore', params.trustscore);
  if (params.numberOfReviews) qs.set('numberOfReviews', params.numberOfReviews);
  if (params.location) qs.set('location', params.location);
  if (semantic) {
    qs.set('variant', 'true');
    qs.set('experiment', 'semantic_search_enabled');
  }
  if (params.page > 1) qs.set('page', String(params.page));
  return `/search?${qs.toString()}`;
}

/** Normalise les paramètres de la recherche dans les avis. */
export function normalizeReviewParams(searchParams) {
  const base = normalizeParams(searchParams);
  const query = clean(searchParams.get('q'), 80);
  if (query.length < 2) throw new ValidationError('Le terme cherché doit faire au moins 2 caractères');
  return { ...base, query, page: readPage(searchParams, 50) };
}

/** Paramètres du mode « Par secteur ». */
export function normalizeCategoryParams(searchParams) {
  const category = clean(searchParams.get('category'), 80);
  if (!category) throw new ValidationError('Choisis un secteur');
  // Les secteurs fins (« bank », « cafe »…) ne sont pas listés mais existent : on laisse passer leur forme.
  if (!CATEGORY_SET.has(category) && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(category)) {
    throw new ValidationError(`Secteur inconnu : ${category}`);
  }

  const country = clean(searchParams.get('country'), 2).toUpperCase() || 'FR';
  if (!COUNTRY_SET.has(country)) throw new ValidationError(`Pays invalide : ${country}`);

  const trustscore = clean(searchParams.get('stars'), 8);
  if (trustscore && !TRUST_SET.has(trustscore)) throw new ValidationError(`Note invalide : ${trustscore}`);

  const sort = clean(searchParams.get('sort'), 20) || 'most_relevant';
  if (!CATEGORY_SORT_SET.has(sort)) throw new ValidationError(`Tri invalide : ${sort}`);

  return {
    category,
    country,
    location: clean(searchParams.get('location'), 80),
    trustscore,
    sort,
    page: readPage(searchParams, MAX_PAGE),
  };
}

export function buildCategoryPath(params) {
  const qs = new URLSearchParams();
  qs.set('country', params.country);
  if (params.location) qs.set('location', params.location);
  if (params.trustscore) qs.set('trustscore', params.trustscore);
  if (params.sort && params.sort !== 'most_relevant') qs.set('sort', params.sort);
  if (params.page > 1) qs.set('page', String(params.page));
  return `/categories/${params.category}?${qs.toString()}`;
}

/** Paramètres du mode « Avis d'une entreprise ». */
export function normalizeCompanyParams(searchParams) {
  const company = clean(searchParams.get('q'), 300);
  if (!company) throw new ValidationError('Indique une entreprise : nom, domaine ou URL');

  const term = clean(searchParams.get('term'), 80);
  const rating = clean(searchParams.get('rating'), 1);
  if (rating && !REVIEW_STAR_SET.has(rating)) throw new ValidationError(`Note invalide : ${rating}`);
  const language = clean(searchParams.get('lang'), 5) || 'all';
  if (!REVIEW_LANG_SET.has(language)) throw new ValidationError(`Langue invalide : ${language}`);
  // Sans terme, la pertinence n'a pas de sens : Trustpilot trie alors par date.
  let sort = clean(searchParams.get('sort'), 12) || 'recency';
  if (!REVIEW_SORT_SET.has(sort)) throw new ValidationError(`Tri invalide : ${sort}`);
  if (!term) sort = 'recency';

  return { company, term, rating, language, sort, page: readPage(searchParams, MAX_REVIEW_PAGE) };
}

export function buildCompanyPath(domain, params) {
  const qs = new URLSearchParams();
  qs.set('languages', params.language || 'all');
  if (params.term) qs.set('search', params.term);
  if (params.rating) qs.set('stars', params.rating);
  qs.set('sort', params.sort || 'recency');
  if (params.page > 1) qs.set('page', String(params.page));
  return `/review/${encodeURIComponent(domain)}?${qs.toString()}`;
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/** pageProps du JSON Next.js embarqué dans une page Trustpilot. */
export function pageProps(html) {
  const match = html.match(NEXT_DATA_RE);
  if (!match) throw new UnexpectedPageError('Page Trustpilot inattendue (__NEXT_DATA__ absent)');
  let props;
  try {
    props = JSON.parse(match[1]).props?.pageProps;
  } catch {
    throw new UnexpectedPageError('Données Trustpilot illisibles');
  }
  if (!props) throw new UnexpectedPageError('Données Trustpilot vides');
  return props;
}

/** Réduit une entreprise aux champs utiles, quelle que soit la page d'origine. */
function mapUnit(unit) {
  const domain = unit.identifyingName;
  const categories = (unit.categories ?? [])
    .slice()
    .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)))
    .map((c) => c.displayName ?? c.name)
    .filter(Boolean);
  return {
    id: unit.businessUnitId ?? unit.id,
    name: unit.displayName,
    domain,
    url: `https://www.trustpilot.com/review/${domain}`,
    stars: Number(unit.trustScore ?? unit.stars ?? 0),
    reviews: Number(unit.numberOfReviews ?? 0),
    // Pays en toutes lettres (recherche, catégories) ou code ISO (fiche entreprise).
    country: unit.location?.country ?? unit.countryCode ?? '',
    city: unit.location?.city ?? '',
    categories: categories.slice(0, 2),
    claimed: Boolean(unit.isClaimed || unit.claimed),
  };
}

function paginate(page, totalPages, totalResults, pageSize) {
  return {
    page,
    pageSize,
    totalPages,
    totalResults,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/** Extrait et réduit les données utiles d'une page de recherche. */
export function parseSearchPage(html) {
  const props = pageProps(html);

  // Saisie reconnue comme un domaine : Trustpilot redirige vers la fiche.
  if (props.businessUnit && !props.businessUnits) {
    return {
      items: [mapUnit(props.businessUnit)],
      pagination: paginate(1, 1, 1, 10),
      source: { searchMode: 'domain', hasActiveFilters: false },
    };
  }

  const pagination = props.pagination ?? {};
  const currentPage = Number(pagination.currentPage ?? 1);
  const totalResults = Number(pagination.totalResults ?? 0);
  const pageSize = Number(pagination.pageSize ?? 10);
  const totalPages = Math.min(
    Number(pagination.totalPages ?? 0) || (totalResults ? Math.ceil(totalResults / pageSize) : 0),
    MAX_PAGE
  );

  return {
    items: (props.businessUnits ?? []).map(mapUnit),
    pagination: paginate(currentPage, totalPages, totalResults, pageSize),
    source: {
      searchMode: props.searchMode ?? null,
      hasActiveFilters: Boolean(props.hasActiveFilters),
    },
  };
}

/** Page de catégorie : mêmes champs que la recherche. */
export function parseCategoryPage(html) {
  const props = pageProps(html);
  const units = props.businessUnits;
  if (!units) throw new UnexpectedPageError('Page de catégorie inattendue');

  const totalResults = Number(units.totalHits ?? 0);
  const pageSize = Number(units.perPage ?? 20);
  const totalPages = Math.min(Number(units.totalPages ?? 0), MAX_PAGE);
  const page = Number(props.page ?? 1);
  const current = props.categories?.currentCategory;

  return {
    items: (units.businesses ?? []).map(mapUnit),
    pagination: paginate(page, totalPages, totalResults, pageSize),
    category: current ? { id: current.categoryId, name: current.displayName } : null,
  };
}

/** Page d'avis d'une entreprise (filtres déjà appliqués par Trustpilot). */
export function parseCompanyPage(html) {
  const props = pageProps(html);
  const unit = props.businessUnit;
  if (!unit && 'isSignup' in props) {
    // Redirection vers la connexion : relancer la session n'y changerait rien.
    const err = new Error('Trustpilot demande une connexion pour aller plus loin dans ces avis');
    err.status = 403;
    throw err;
  }
  if (!unit) throw new UnexpectedPageError('Fiche entreprise inattendue');

  const pag = props.filters?.pagination ?? {};
  const totalResults = Number(pag.totalCount ?? 0);
  const pageSize = Number(pag.perPage ?? 20);
  const totalPages = Math.min(
    Number(pag.totalPages ?? 0) || (totalResults ? Math.ceil(totalResults / pageSize) : 0),
    MAX_REVIEW_PAGE
  );
  const page = Number(pag.currentPage ?? 1);

  const business = mapUnit(unit);

  const reviews = (props.reviews ?? []).map((r) => ({
    id: r.id,
    title: r.title ?? '',
    text: (r.text ?? '').slice(0, 1500),
    rating: Number(r.rating ?? 0),
    author: r.consumer?.displayName ?? 'Anonyme',
    country: r.consumer?.countryCode ?? '',
    language: r.language ?? '',
    date: r.dates?.publishedDate ?? r.dates?.experiencedDate ?? null,
    replied: Boolean(r.reply),
    url: `https://www.trustpilot.com/reviews/${r.id}`,
  }));

  return {
    business,
    reviews,
    pagination: paginate(page, totalPages, totalResults, pageSize),
  };
}
