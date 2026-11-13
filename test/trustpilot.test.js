import test from 'node:test';
import assert from 'node:assert/strict';
import {
  domainFrom,
  normalizeFindParams,
  needsServerFilter,
  searchSource,
  companyReviewParams,
  scanReviewParams,
  buildPath,
  buildCategoryPath,
  buildCompanyPath,
  pageProps,
  parseSearchPage,
  parseCategoryPage,
  parseCompanyPage,
} from '../src/trustpilot.js';

/** Page Trustpilot minimale : seul le JSON `__NEXT_DATA__` compte pour les parseurs. */
const page = (props) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: props },
  })}</script></body></html>`;

const find = (query) => normalizeFindParams(new URLSearchParams(query));

const unit = (over = {}) => ({
  businessUnitId: 'abc123',
  displayName: 'Fnac',
  identifyingName: 'www.fnac.com',
  trustScore: 4.1,
  numberOfReviews: 30653,
  location: { country: 'France', city: 'Paris' },
  categories: [
    { displayName: 'Librairie' },
    { displayName: 'Électronique', isPrimary: true },
    { displayName: 'Musique' },
  ],
  isClaimed: true,
  ...over,
});

test('domainFrom reconnaît un domaine ou une URL', () => {
  assert.equal(domainFrom('https://www.fnac.com/x?y=1'), 'www.fnac.com');
  assert.equal(domainFrom('fnac.com'), 'fnac.com');
  assert.equal(domainFrom('FNAC.COM.'), 'fnac.com');
  assert.equal(domainFrom('fnac.com:8080'), 'fnac.com');
  assert.equal(domainFrom('café.fr'), 'xn--caf-dma.fr');
});

test('domainFrom renvoie null pour un nom', () => {
  for (const input of ['', 'boulangerie paris', 'fnac', 'localhost', '1.2.3.4', '.fr']) {
    assert.equal(domainFrom(input), null, input);
  }
});

test('normalizeFindParams déduit le type de résultat', () => {
  assert.equal(find('q=fnac').kind, 'list');
  assert.equal(find('category=bank').kind, 'list');
  assert.equal(find('q=fnac&term=frais').kind, 'scan');
  assert.equal(find('q=fnac&rating=1').kind, 'scan');
  assert.equal(find('q=fnac&lang=fr').kind, 'scan');
  assert.equal(find('term=frais').kind, 'scan');
  const company = find('q=https://www.fnac.com/x&category=bank&term=frais');
  assert.equal(company.kind, 'company');
  assert.equal(company.domain, 'www.fnac.com');
});

test('normalizeFindParams applique les valeurs par défaut', () => {
  assert.deepEqual(find('q=fnac'), {
    kind: 'list', q: 'fnac', domain: null, category: '', country: '', city: '',
    trustscore: '', numberOfReviews: '', term: '', rating: '', language: 'all',
    sort: 'relevance', page: 1,
  });
  assert.equal(find('q=x&country=fr').country, 'FR');
  assert.equal(find('q=  deux   mots ').q, 'deux mots');
});

test('normalizeFindParams borne la page', () => {
  assert.equal(find('q=x&page=abc').page, 1);
  assert.equal(find('q=x&page=-4').page, 1);
  assert.equal(find('q=x&page=7').page, 7);
  assert.equal(find('q=x&page=99999').page, 1000);
  assert.equal(find('q=fnac.com&page=50').page, 10);
});

test('normalizeFindParams refuse les valeurs invalides en 400', () => {
  const invalid = [
    '', 'rating=3', 'lang=fr', 'q=x&country=ZZ', 'q=x&stars=2', 'q=x&reviews=30',
    'q=x&term=a', 'q=x&rating=6', 'q=x&lang=zz', 'q=x&sort=name', 'category=Bank!',
  ];
  for (const query of invalid) {
    assert.throws(() => find(query), (err) => err.status === 400, query);
  }
});

test('normalizeFindParams laisse passer un secteur fin non listé', () => {
  assert.equal(find('category=some_fine_sector').category, 'some_fine_sector');
});

test('needsServerFilter : nom ou nombre d’avis sur un secteur', () => {
  assert.equal(needsServerFilter(find('category=bank')), false);
  assert.equal(needsServerFilter(find('category=bank&q=bnp')), true);
  assert.equal(needsServerFilter(find('category=bank&reviews=500')), true);
  assert.equal(needsServerFilter(find('q=bnp&reviews=500')), false);
});

test('searchSource : la ville prime sur le pays, le texte d’avis sert de mot-clé', () => {
  assert.deepEqual(searchSource(find('q=bnp&country=FR&stars=4.0&reviews=50')), {
    query: 'bnp', trustscore: '4.0', numberOfReviews: '50', location: 'France', page: 1,
  });
  assert.equal(searchSource(find('q=bnp&country=FR&city=Lyon')).location, 'Lyon');
  assert.equal(searchSource(find('term=frais')).query, 'frais');
});

test('companyReviewParams : la pertinence n’existe qu’avec un texte', () => {
  assert.equal(companyReviewParams(find('q=fnac.com&term=frais')).sort, 'relevance');
  assert.equal(companyReviewParams(find('q=fnac.com&term=frais&sort=recent')).sort, 'recency');
  assert.equal(companyReviewParams(find('q=fnac.com')).sort, 'recency');
});

test('buildPath', () => {
  assert.equal(
    buildPath({ query: 'boulangerie paris', page: 1 }),
    '/search?query=boulangerie+paris&variant=true&experiment=semantic_search_enabled'
  );
  assert.equal(
    buildPath(
      { query: 'x', trustscore: '4.0', numberOfReviews: '50', location: 'France', page: 2 },
      { semantic: false }
    ),
    '/search?query=x&trustscore=4.0&numberOfReviews=50&location=France&page=2'
  );
});

test('buildCategoryPath', () => {
  assert.equal(
    buildCategoryPath({ category: 'bank', country: 'FR', location: 'Lyon', trustscore: '4.0', sort: 'reviews', page: 3 }),
    '/categories/bank?country=FR&location=Lyon&trustscore=4.0&sort=reviews_count&page=3'
  );
  assert.equal(buildCategoryPath({ category: 'bank', sort: 'relevance', page: 1 }), '/categories/bank?');
  assert.equal(buildCategoryPath({ category: 'bank', sort: 'recent', page: 1 }), '/categories/bank?sort=latest_review');
});

test('buildCompanyPath', () => {
  assert.equal(
    buildCompanyPath('fnac.com', { language: 'all', term: 'frais de port', rating: '1', sort: 'relevance', page: 1 }),
    '/review/fnac.com?languages=all&search=frais+de+port&stars=1&sort=relevance'
  );
  assert.equal(buildCompanyPath('fnac.com', { page: 3 }), '/review/fnac.com?languages=all&sort=recency&page=3');
});

test('pageProps : une page sans données est une erreur à réessayer', () => {
  assert.throws(() => pageProps('<html>challenge</html>'), (err) => err.retryable === true);
  assert.throws(
    () => pageProps('<script id="__NEXT_DATA__">{pas du json</script>'),
    (err) => err.retryable === true
  );
  assert.throws(
    () => pageProps('<script id="__NEXT_DATA__">{"props":{}}</script>'),
    (err) => err.retryable === true
  );
  assert.deepEqual(pageProps(page({ a: 1 })), { a: 1 });
});

test('parseSearchPage réduit les entreprises aux champs utiles', () => {
  const parsed = parseSearchPage(
    page({
      businessUnits: [unit()],
      pagination: { currentPage: 2, totalResults: 45, pageSize: 10, totalPages: 5 },
      searchMode: 'semantic',
      hasActiveFilters: true,
    })
  );
  assert.deepEqual(parsed.items, [
    {
      id: 'abc123',
      name: 'Fnac',
      domain: 'www.fnac.com',
      url: 'https://www.trustpilot.com/review/www.fnac.com',
      stars: 4.1,
      reviews: 30653,
      country: 'France',
      city: 'Paris',
      categories: ['Électronique', 'Librairie'],
      claimed: true,
    },
  ]);
  assert.deepEqual(parsed.pagination, {
    page: 2, pageSize: 10, totalPages: 5, totalResults: 45, hasNext: true, hasPrevious: true,
  });
  assert.deepEqual(parsed.source, { searchMode: 'semantic', hasActiveFilters: true });
});

test('parseSearchPage : total de pages calculé puis plafonné à 1000', () => {
  const computed = parseSearchPage(page({ businessUnits: [], pagination: { totalResults: 45, pageSize: 10 } }));
  assert.equal(computed.pagination.totalPages, 5);
  const capped = parseSearchPage(page({ businessUnits: [], pagination: { totalResults: 50000, totalPages: 5000 } }));
  assert.equal(capped.pagination.totalPages, 1000);
  const empty = parseSearchPage(page({}));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pagination.totalPages, 0);
});

test('parseSearchPage : saisie reconnue comme un domaine', () => {
  const parsed = parseSearchPage(page({ businessUnit: unit() }));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].domain, 'www.fnac.com');
  assert.equal(parsed.source.searchMode, 'domain');
  assert.equal(parsed.pagination.totalResults, 1);
});

test('parseCategoryPage', () => {
  const parsed = parseCategoryPage(
    page({
      businessUnits: { businesses: [unit({ stars: 3.5, trustScore: undefined })], totalHits: 61, perPage: 20, totalPages: 4 },
      page: 2,
      categories: { currentCategory: { categoryId: 'bank', displayName: 'Banque' } },
    })
  );
  assert.equal(parsed.items[0].stars, 3.5);
  assert.deepEqual(parsed.pagination, {
    page: 2, pageSize: 20, totalPages: 4, totalResults: 61, hasNext: true, hasPrevious: true,
  });
  assert.deepEqual(parsed.category, { id: 'bank', name: 'Banque' });
  assert.throws(() => parseCategoryPage(page({})), (err) => err.retryable === true);
});

test('parseCompanyPage', () => {
  const parsed = parseCompanyPage(
    page({
      businessUnit: unit({ location: undefined, countryCode: 'FR' }),
      filters: { pagination: { totalCount: 500, perPage: 20, totalPages: 25, currentPage: 2 } },
      reviews: [
        {
          id: 'r1',
          title: 'Trop de <em>frais</em>',
          text: 'x'.repeat(2000),
          rating: 1,
          consumer: { displayName: 'Ana', countryCode: 'FR' },
          language: 'fr',
          dates: { publishedDate: '2026-01-02T10:00:00.000Z' },
          reply: { message: 'Bonjour' },
        },
        { id: 'r2' },
      ],
    })
  );
  assert.equal(parsed.business.country, 'FR');
  assert.equal(parsed.business.city, '');
  // Au-delà de la 10e page d'avis, Trustpilot exige une connexion.
  assert.equal(parsed.pagination.totalPages, 10);
  assert.equal(parsed.pagination.totalResults, 500);
  assert.equal(parsed.pagination.page, 2);
  assert.deepEqual(
    { ...parsed.reviews[0], text: parsed.reviews[0].text.length },
    {
      id: 'r1',
      title: 'Trop de <em>frais</em>',
      text: 1500,
      rating: 1,
      author: 'Ana',
      country: 'FR',
      language: 'fr',
      date: '2026-01-02T10:00:00.000Z',
      replied: true,
      url: 'https://www.trustpilot.com/reviews/r1',
    }
  );
  assert.deepEqual(parsed.reviews[1], {
    id: 'r2', title: '', text: '', rating: 0, author: 'Anonyme', country: '', language: '',
    date: null, replied: false, url: 'https://www.trustpilot.com/reviews/r2',
  });
});

test('parseCompanyPage : connexion exigée ou fiche absente', () => {
  assert.throws(
    () => parseCompanyPage(page({ isSignup: false })),
    (err) => err.status === 403 && !err.retryable
  );
  assert.throws(() => parseCompanyPage(page({})), (err) => err.retryable === true);
});

test('la fouille et la fiche d’une entreprise lisent la même page d’avis', () => {
  for (const query of ['q=fnac.com&term=frais&rating=1&lang=fr', 'q=fnac.com&rating=1', 'q=fnac.com&lang=fr']) {
    const p = find(query);
    assert.equal(
      buildCompanyPath('fnac.com', scanReviewParams(p)),
      buildCompanyPath('fnac.com', companyReviewParams(p)),
      query
    );
  }
  assert.equal(
    buildCompanyPath('fnac.com', scanReviewParams(find('q=x&term=frais&rating=1&lang=fr'))),
    '/review/fnac.com?languages=fr&search=frais&stars=1&sort=relevance'
  );
});
