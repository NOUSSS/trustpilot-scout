import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector } from '../src/reviews.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Source d'une seule page avec les domaines donnés. */
const onePage = (...domains) => async () => ({
  items: domains.map((domain) => ({ domain, reviews: 5 })),
  pagination: { totalResults: domains.length, totalPages: 1 },
});

const failure = (status) => Object.assign(new Error(`Trustpilot a répondu ${status}`), { status });

test('Collector : avis illisibles, l’entreprise est réessayée au prochain appel', async () => {
  const collector = new Collector();
  let down = true;
  const calls = [];
  const job = {
    loadPage: onePage('a.com', 'b.com'),
    keep: () => true,
    enrich: async (b) => {
      calls.push(b.domain);
      if (down && b.domain === 'a.com') throw failure(503);
      return { ...b, matchCount: 1 };
    },
  };

  const first = await collector.ensure('k', job, 9);
  assert.deepEqual(first.hits.map((h) => h.domain), ['b.com']);
  assert.equal(first.pending.length, 1);
  assert.equal(first.partial, true);
  assert.equal(first.exhausted, true);

  down = false;
  const second = await collector.ensure('k', job, 9);
  assert.deepEqual(second.hits.map((h) => h.domain), ['b.com', 'a.com']);
  assert.equal(second.pending.length, 0);
  assert.equal(second.partial, false);
  // b.com n'est pas réinterrogée.
  assert.deepEqual(calls, ['a.com', 'b.com', 'a.com']);
});

test('Collector : une fiche introuvable n’est pas réessayée', async () => {
  const collector = new Collector();
  let calls = 0;
  const job = {
    loadPage: onePage('a.com'),
    keep: () => true,
    enrich: async () => {
      calls++;
      throw failure(404);
    },
  };
  const state = await collector.ensure('k', job, 9);
  assert.equal(state.pending.length, 0);
  assert.equal(state.partial, false);
  await collector.ensure('k', job, 9);
  assert.equal(calls, 1);
});

test('Collector : trois échecs, l’entreprise est abandonnée', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const collector = new Collector();
  let calls = 0;
  const job = {
    loadPage: onePage('a.com'),
    keep: () => true,
    enrich: async () => {
      calls++;
      throw failure(503);
    },
  };
  for (let i = 0; i < 5; i++) await collector.ensure('k', job, 9);
  assert.equal(calls, 3);
  const state = collector.peek('k');
  assert.equal(state.pending.length, 0);
  assert.equal(state.partial, false);
  assert.equal(state.hits.length, 0);
});

test('Collector : rejoindre un scan en cours donne quand même la page demandée', async () => {
  const collector = new Collector();
  const calls = [];
  const job = {
    loadPage: async (n) => {
      calls.push(n);
      await sleep(5);
      return {
        items: Array.from({ length: 20 }, (_, i) => ({ domain: `p${n}-${i}.com`, reviews: 5 })),
        pagination: { totalResults: 2000, totalPages: 100 },
      };
    },
    keep: () => true,
    enrich: null,
  };
  const [first, third] = await Promise.all([
    collector.ensure('k', job, 21),
    collector.ensure('k', job, 61),
  ]);
  assert.equal(first, third);
  assert.ok(third.hits.length >= 61, `obtenu ${third.hits.length}`);
  // Aucune page de la source lue deux fois.
  assert.deepEqual(calls, [1, 2, 3, 4]);
});

test('Collector : une page déjà trouvée n’attend pas le parcours en cours', async () => {
  const collector = new Collector();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = {
    loadPage: async (n) => {
      if (n > 1) await gate;
      return {
        items: Array.from({ length: 20 }, (_, i) => ({ domain: `p${n}-${i}.com`, reviews: 5 })),
        pagination: { totalResults: 2000, totalPages: 100 },
      };
    },
    keep: () => true,
    enrich: null,
  };
  await collector.ensure('k', job, 9);
  // Fouille de fond : elle reste bloquée sur la page 2.
  const background = collector.ensure('k', job, 600);
  await sleep(5);
  const page = await Promise.race([
    collector.ensure('k', job, 17),
    sleep(200).then(() => 'bloquée'),
  ]);
  assert.notEqual(page, 'bloquée');
  assert.equal(page.hits.length, 20);
  release();
  await background;
});
