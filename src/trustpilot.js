/** Construction des recherches et lecture des résultats Trustpilot. */
import fs from 'node:fs';

export const TRUST_SCORES = [
  { value: '', label: 'Toutes' },
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

export const REVIEW_STARS = [
  { value: '', label: 'Toutes' },
  { value: '5', label: '5 étoiles' },
  { value: '4', label: '4 étoiles' },
  { value: '3', label: '3 étoiles' },
  { value: '2', label: '2 étoiles' },
  { value: '1', label: '1 étoile' },
];

/** Profil revendiqué par l'entreprise, et réponses de l'entreprise aux avis. */
export const CLAIMED = [
  { value: '', label: 'Peu importe' },
  { value: 'yes', label: 'Oui' },
  { value: 'no', label: 'Non' },
];

export const REPLIES = [
  { value: '', label: 'Peu importe' },
  { value: 'yes', label: 'Oui' },
  { value: 'no', label: 'Non' },
];

export const REVIEW_LANGUAGES = ['all', 'fr', 'en', 'de', 'es', 'it', 'nl', 'pt', 'da', 'sv', 'pl'];

/**
 * Tris communs. Un secteur les accepte tous ; les avis d'une entreprise
 * acceptent la pertinence et la date ; la recherche par mot-clé n'en a aucun.
 */
export const SORTS = [
  { value: 'relevance', label: 'Pertinence' },
  { value: 'reviews', label: 'Nombre d’avis' },
  { value: 'recent', label: 'Avis récents' },
];

const CATEGORY_SORT = { relevance: 'most_relevant', reviews: 'reviews_count', recent: 'latest_review' };

/**
 * Continents : chacun regroupe des pays de la liste, cherchés un par un, car
 * Trustpilot ne filtre qu'un pays à la fois. Identifiants en toutes lettres,
 * pour ne pas se confondre avec un code ISO (AF, NA, SA…).
 */
export const CONTINENTS = [
  {
    id: 'europe',
    name: 'Europe',
    countries: [
      'FR', 'BE', 'CH', 'LU', 'GB', 'IE', 'DE', 'AT', 'NL', 'IT', 'ES', 'PT', 'DK', 'SE', 'NO', 'FI',
      'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'EE', 'UA',
    ],
  },
  { id: 'afrique', name: 'Afrique', countries: ['MA', 'TN', 'DZ', 'SN', 'CI', 'ZA'] },
  { id: 'amerique-nord', name: 'Amérique du Nord', countries: ['US', 'CA', 'MX'] },
  { id: 'amerique-sud', name: 'Amérique du Sud', countries: ['BR', 'AR', 'CO', 'CL'] },
  { id: 'asie', name: 'Asie', countries: ['JP', 'CN', 'HK', 'SG', 'KR', 'IN', 'AE'] },
  { id: 'oceanie', name: 'Océanie', countries: ['AU', 'NZ'] },
];

/** Marchés principaux de Trustpilot (codes ISO, noms traduits côté client). */
export const COUNTRIES = CONTINENTS.flatMap((c) => c.countries);

const CONTINENT_COUNTRIES = new Map(CONTINENTS.map((c) => [c.id, c.countries]));

/** Pays d'un continent choisi, ou null pour un pays seul (ou aucun). */
export const continentCountries = (country) => CONTINENT_COUNTRIES.get(country) ?? null;

/**
 * Catégories sur trois niveaux : secteur, sous-secteur, spécialité (noms
 * français relevés sur fr.trustpilot.com, apostrophes typographiques).
 */
export const CATEGORIES = JSON.parse(
  fs.readFileSync(new URL('./categories.fr.json', import.meta.url), 'utf8')
);

const TRUST_SET = new Set(TRUST_SCORES.map((o) => o.value).filter(Boolean));
const REVIEW_SET = new Set(REVIEW_COUNTS.map((o) => o.value).filter(Boolean));
const REVIEW_STAR_SET = new Set(REVIEW_STARS.map((o) => o.value).filter(Boolean));
const REVIEW_LANG_SET = new Set(REVIEW_LANGUAGES);
const CLAIMED_SET = new Set(CLAIMED.map((o) => o.value).filter(Boolean));
const REPLIES_SET = new Set(REPLIES.map((o) => o.value).filter(Boolean));
const SORT_SET = new Set(SORTS.map((o) => o.value));
const COUNTRY_SET = new Set(COUNTRIES);
const CATEGORY_SET = new Set(
  CATEGORIES.flatMap((c) => [c.id, ...c.sub.flatMap((s) => [s.id, ...(s.sub ?? []).map((l) => l.id)])])
);

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
  if (params.claimed) qs.set('claimed', 'true');
  if (semantic) {
    qs.set('variant', 'true');
    qs.set('experiment', 'semantic_search_enabled');
  }
  if (params.page > 1) qs.set('page', String(params.page));
  return `/search?${qs.toString()}`;
}

export function buildCategoryPath(params) {
  const qs = new URLSearchParams();
  if (params.country) qs.set('country', params.country);
  if (params.location) qs.set('location', params.location);
  if (params.trustscore) qs.set('trustscore', params.trustscore);
  if (params.claimed) qs.set('claimed', 'true');
  const sort = CATEGORY_SORT[params.sort];
  if (sort && sort !== 'most_relevant') qs.set('sort', sort);
  if (params.page > 1) qs.set('page', String(params.page));
  return `/categories/${params.category}?${qs.toString()}`;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Normalise et valide les paramètres de la recherche unifiée, et en déduit le
 * type de résultat :
 * - `company` : un domaine ou une URL, ses avis filtrés ;
 * - `scan` : un filtre d'avis (mots, phrase, note de l'avis, langue), les entreprises
 *   de la source dont au moins un avis correspond ;
 * - `list` : les entreprises de la source.
 * La source est le secteur s'il est choisi, sinon la recherche (ou, à défaut,
 * le texte des avis comme mot-clé).
 */
export function normalizeFindParams(searchParams) {
  const q = clean(searchParams.get('q'), 300);
  const domain = domainFrom(q);

  const category = clean(searchParams.get('category'), 80);
  // Un secteur apparu depuis le relevé de la liste existe peut-être : on laisse passer sa forme.
  if (category && !CATEGORY_SET.has(category) && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(category)) {
    throw new ValidationError(`Secteur inconnu : ${category}`);
  }

  // Un pays (code ISO) ou un continent (identifiant en minuscules).
  const place = clean(searchParams.get('country'), 20);
  const country = continentCountries(place.toLowerCase()) ? place.toLowerCase() : place.toUpperCase();
  if (country && !COUNTRY_SET.has(country) && !continentCountries(country)) {
    throw new ValidationError(`Pays invalide : ${place}`);
  }
  const city = clean(searchParams.get('city'), 80);

  const trustscore = clean(searchParams.get('stars'), 8);
  if (trustscore && !TRUST_SET.has(trustscore)) throw new ValidationError(`Note invalide : ${trustscore}`);
  const numberOfReviews = clean(searchParams.get('reviews'), 8);
  if (numberOfReviews && !REVIEW_SET.has(numberOfReviews)) {
    throw new ValidationError(`Nombre d'avis invalide : ${numberOfReviews}`);
  }

  const term = clean(searchParams.get('term'), 80);
  if (term && term.length < 2) {
    throw new ValidationError('Les mots cherchés dans les avis doivent faire au moins 2 caractères');
  }
  // Une seule phrase, mise entre guillemets pour Trustpilot : les siens sont retirés.
  const phrase = clean(clean(searchParams.get('phrase'), 80).replace(/["“”«»]/g, ' '), 80);
  if (phrase && phrase.length < 2) {
    throw new ValidationError('La phrase cherchée dans les avis doit faire au moins 2 caractères');
  }
  const rating = clean(searchParams.get('rating'), 1);
  if (rating && !REVIEW_STAR_SET.has(rating)) throw new ValidationError(`Note d'avis invalide : ${rating}`);
  const language = clean(searchParams.get('lang'), 5) || 'all';
  if (!REVIEW_LANG_SET.has(language)) throw new ValidationError(`Langue invalide : ${language}`);
  const sort = clean(searchParams.get('sort'), 12) || 'relevance';
  if (!SORT_SET.has(sort)) throw new ValidationError(`Tri invalide : ${sort}`);
  const claimed = clean(searchParams.get('claimed'), 3);
  if (claimed && !CLAIMED_SET.has(claimed)) throw new ValidationError(`Profil revendiqué invalide : ${claimed}`);
  const replies = clean(searchParams.get('replies'), 3);
  if (replies && !REPLIES_SET.has(replies)) throw new ValidationError(`Réponses aux avis invalide : ${replies}`);

  const kind = domain ? 'company' : term || phrase || rating || language !== 'all' ? 'scan' : 'list';
  if (kind !== 'company' && !q && !category && !term && !phrase) {
    throw new ValidationError('Indique une entreprise, un secteur ou un texte à chercher dans les avis');
  }
  const maxPage = kind === 'company' ? MAX_REVIEW_PAGE : MAX_PAGE;

  return {
    kind, q, domain, category, country, city, trustscore, numberOfReviews,
    term, phrase, rating, language, sort, claimed, replies, page: readPage(searchParams, maxPage),
    // Fouille de fond : la collecte avance jusqu'à son plafond, pas seulement jusqu'à la page.
    fill: searchParams.get('fill') === '1',
  };
}

/** Filtres que Trustpilot ne sait pas appliquer à un secteur : le serveur s'en charge. */
export const needsServerFilter = (p) => Boolean(p.category && (p.q || p.numberOfReviews));

/**
 * Filtres de profil que seule la fiche de chaque entreprise renseigne. Trustpilot
 * sait garder les profils revendiqués, pas les autres ni les réponses aux avis.
 */
export const needsProfile = (p) => p.kind !== 'company' && (p.claimed === 'no' || Boolean(p.replies));

/** L'entreprise d'une fiche lue (`parseCompanyPage`) passe-t-elle les filtres de profil ? */
export function profileMatches(p, page) {
  const { business } = page;
  if (p.claimed && (p.claimed === 'yes') !== business.claimed) return false;
  if (p.replies) {
    const replies = business.replyRate > 0 || page.reviews.some((r) => r.replied);
    if ((p.replies === 'yes') !== replies) return false;
  }
  return true;
}

/** Texte cherché dans les avis : n'importe lequel des mots, ou la phrase exacte. */
export const reviewSearch = (p) => [p.term, p.phrase && `"${p.phrase}"`].filter(Boolean).join(' ');

/** Paramètres de la recherche Trustpilot qui sert de source. */
export function searchSource(p) {
  let location = p.city;
  if (!location && p.country) {
    try {
      location = regionNames.of(p.country);
    } catch {
      location = '';
    }
  }
  return {
    query: (p.q || p.term || p.phrase).slice(0, 120),
    trustscore: p.trustscore,
    numberOfReviews: p.numberOfReviews,
    location,
    claimed: p.claimed === 'yes',
    page: 1,
  };
}

/** Paramètres de la page de secteur qui sert de source. */
export const categorySource = (p) => ({
  category: p.category,
  country: p.country,
  location: p.city,
  trustscore: p.trustscore,
  claimed: p.claimed === 'yes',
  sort: p.sort,
  page: 1,
});

/** Paramètres de la page d'avis d'une entreprise. */
export const companyReviewParams = (p) => ({
  search: reviewSearch(p),
  rating: p.rating,
  language: p.language,
  // Sans texte cherché, la pertinence n'a pas de sens : Trustpilot trie alors par date.
  sort: reviewSearch(p) && p.sort === 'relevance' ? 'relevance' : 'recency',
  page: p.page,
});

/**
 * Paramètres de la page d'avis lue par la fouille : la première page, triée
 * comme l'ouvrira la fiche de l'entreprise (même URL, donc même entrée de cache).
 */
export const scanReviewParams = (p) => ({
  search: reviewSearch(p),
  rating: p.rating,
  language: p.language,
  sort: reviewSearch(p) ? 'relevance' : 'recency',
  page: 1,
});

export function buildCompanyPath(domain, params) {
  const qs = new URLSearchParams();
  qs.set('languages', params.language || 'all');
  if (params.search) qs.set('search', params.search);
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
    // Part des avis négatifs auxquels l'entreprise a répondu (fiche entreprise seulement).
    replyRate: unit.activity?.replyBehavior ? Number(unit.activity.replyBehavior.replyPercentage ?? 0) : null,
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

/**
 * Page `round` d'un continent, faite des pages `round` de ses pays (null : pays
 * sans page à ce tour). Les entreprises alternent d'un pays à l'autre, ou sont
 * rangées par nombre d'avis quand c'est le tri demandé. `sourcePages` compte les
 * pages réellement lues, pour le plafond du parcours.
 */
export function mergeCountryPages(pages, round, { byReviews = false } = {}) {
  const lists = pages.filter(Boolean);
  const items = [];
  const longest = Math.max(0, ...lists.map((p) => p.items.length));
  for (let i = 0; i < longest; i++) {
    for (const p of lists) if (i < p.items.length) items.push(p.items[i]);
  }
  if (byReviews) items.sort((a, b) => b.reviews - a.reviews);
  const totalPages = Math.max(0, ...lists.map((p) => p.pagination.totalPages));
  const totalResults = lists.reduce((sum, p) => sum + p.pagination.totalResults, 0);
  return {
    items,
    pagination: { ...paginate(round, totalPages, totalResults, items.length), sourcePages: lists.length },
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
