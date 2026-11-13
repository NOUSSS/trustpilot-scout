import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Collector, reviewMatches } from '../src/reviews.js';

/** Source factice : `pages` pages de `perPage` entreprises. */
function source({ pages = 3, perPage = 20 } = {}) {
  const calls = [];
  return {
    calls,
    loadPage: async (n) => {
      calls.push(n);
      const items = Array.from({ length: perPage }, (_, i) => ({
        domain: `p${n}-${i}.com`,
        name: `Entreprise ${n}-${i}`,
        reviews: 10,
      }));
      return { items, pagination: { totalResults: pages * perPage, totalPages: pages } };
    },
  };
}

test('reviewMatches : total et extraits bornés', () => {
  const review = (id) => ({
    id,
    title: 'Titre',
    text: `<em>frais</em> ${'x'.repeat(400)}`,
    rating: 2,
    author: 'Ana',
    country: 'FR',
    language: 'fr',
    date: '2026-01-02T10:00:00.000Z',
    replied: true,
    url: `https://www.trustpilot.com/reviews/${id}`,
  });
  const summary = reviewMatches({
    reviews: ['a', 'b', 'c', 'd'].map(review),
    pagination: { totalResults: 12 },
  });
  assert.equal(summary.total, 12);
  assert.equal(summary.matches.length, CONFIG.reviewSnippets);
  assert.deepEqual(
    { ...summary.matches[0], text: summary.matches[0].text.length },
    {
      id: 'a', text: 320, title: 'Titre', rating: 2, author: 'Ana', country: 'FR', language: 'fr',
      date: '2026-01-02T10:00:00.000Z', url: 'https://www.trustpilot.com/reviews/a',
    }
  );
  assert.deepEqual(
    reviewMatches({ reviews: [review('a')], pagination: { totalResults: 0 } }),
    { total: 0, matches: [] }
  );
});

test('Collector s’arrête dès qu’il a assez de résultats', async () => {
  const collector = new Collector();
  const src = source();
  const state = await collector.ensure('k', { loadPage: src.loadPage, keep: () => true, enrich: null }, 21);
  assert.deepEqual(src.calls, [1, 2]);
  assert.equal(state.hits.length, 40);
  assert.equal(state.scannedItems, 40);
  assert.equal(state.totalSource, 60);
  assert.equal(state.exhausted, false);
  assert.equal(state.partial, false);
});

test('Collector reprend le même état sans rescanner', async () => {
  const collector = new Collector();
  const src = source();
  const job = { loadPage: src.loadPage, keep: () => true, enrich: null };
  await collector.ensure('k', job, 21);
  const state = await collector.ensure('k', job, 41);
  assert.deepEqual(src.calls, [1, 2, 3]);
  assert.equal(state.hits.length, 60);
  assert.equal(state.exhausted, true);
  assert.equal(collector.peek('k'), state);
  assert.equal(collector.peek('autre'), null);
});

test('Collector applique keep puis enrich, dans l’ordre de la source', async () => {
  const collector = new Collector();
  const src = source({ pages: 1, perPage: 6 });
  const state = await collector.ensure(
    'k',
    {
      loadPage: src.loadPage,
      keep: (b) => !b.domain.endsWith('-0.com'),
      enrich: async (b) => (b.domain.endsWith('-3.com') ? null : { ...b, matchCount: 1 }),
    },
    100
  );
  assert.deepEqual(
    state.hits.map((h) => h.domain),
    ['p1-1.com', 'p1-2.com', 'p1-4.com', 'p1-5.com']
  );
  assert.equal(state.hits[0].matchCount, 1);
  assert.equal(state.scannedItems, 6);
  assert.equal(state.exhausted, true);
});

test('Collector ne garde qu’une fois un domaine vu sur deux pages', async () => {
  const collector = new Collector();
  const state = await collector.ensure(
    'k',
    {
      loadPage: async () => ({
        items: [{ domain: 'a.com', reviews: 1 }, { domain: 'b.com', reviews: 1 }],
        pagination: { totalResults: 4, totalPages: 2 },
      }),
      keep: () => true,
      enrich: null,
    },
    100
  );
  assert.deepEqual(state.hits.map((h) => h.domain), ['a.com', 'b.com']);
  assert.equal(state.scannedPages, 2);
});

test('Collector : budget temps dépassé, scan partiel et reprenable', async () => {
  const collector = new Collector();
  const src = source();
  const job = { loadPage: src.loadPage, keep: () => true, enrich: null };
  const budget = CONFIG.reviewScanBudgetMs;
  // Budget négatif : dépassé dès le premier tour, sans dépendre de l'horloge.
  CONFIG.reviewScanBudgetMs = -1;
  try {
    const state = await collector.ensure('k', job, 21);
    assert.equal(state.partial, true);
    assert.equal(state.capped, false);
    assert.equal(state.hits.length, 0);
    assert.deepEqual(src.calls, []);
  } finally {
    CONFIG.reviewScanBudgetMs = budget;
  }
  const resumed = await collector.ensure('k', job, 21);
  assert.equal(resumed.partial, false);
  assert.equal(resumed.hits.length, 40);
});

test('Collector : plafond de pages définitif', async () => {
  const collector = new Collector();
  const src = source({ pages: 5 });
  const job = { loadPage: src.loadPage, keep: () => true, enrich: null };
  const maxPages = CONFIG.reviewMaxScanPages;
  CONFIG.reviewMaxScanPages = 2;
  try {
    const state = await collector.ensure('k', job, 1000);
    assert.equal(state.capped, true);
    assert.equal(state.partial, true);
    assert.equal(state.exhausted, false);
    await collector.ensure('k', job, 1000);
    assert.deepEqual(src.calls, [1, 2]);
  } finally {
    CONFIG.reviewMaxScanPages = maxPages;
  }
});

test('Collector : source en erreur sans résultat, l’erreur remonte', async () => {
  const collector = new Collector();
  const err = Object.assign(new Error('Trustpilot a répondu 404'), { status: 404 });
  await assert.rejects(
    collector.ensure('k', { loadPage: async () => { throw err; }, keep: () => true, enrich: null }, 21),
    (thrown) => thrown === err
  );
});

test('Collector : source en erreur après des résultats, on garde l’acquis', async () => {
  const collector = new Collector();
  const src = source();
  const state = await collector.ensure(
    'k',
    {
      loadPage: async (n) => {
        if (n === 2) throw new Error('503');
        return src.loadPage(n);
      },
      keep: () => true,
      enrich: null,
    },
    21
  );
  assert.equal(state.hits.length, 20);
  assert.equal(state.partial, true);
  assert.equal(state.error.message, '503');
  assert.equal(state.running, null);
});
