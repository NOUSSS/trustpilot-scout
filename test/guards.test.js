import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { Limiter } from '../src/cache.js';
import { RateLimiter } from '../src/ratelimit.js';
import { Collector } from '../src/reviews.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('RateLimiter : au plus max requêtes par fenêtre et par client', () => {
  const limiter = new RateLimiter({ max: 2, windowMs: 60000 });
  assert.equal(limiter.take('a', 1000), 0);
  assert.equal(limiter.take('a', 2000), 0);
  assert.equal(limiter.take('a', 3000), 58);
  // Un autre client a sa propre fenêtre.
  assert.equal(limiter.take('b', 3000), 0);
  // Fenêtre écoulée : le compteur repart.
  assert.equal(limiter.take('a', 61000), 0);
});

test('RateLimiter oublie les clients les plus anciens au-delà de maxKeys', () => {
  const limiter = new RateLimiter({ max: 1, windowMs: 60000, maxKeys: 2 });
  limiter.take('a', 0);
  limiter.take('b', 0);
  limiter.take('c', 0);
  assert.equal(limiter.windows.size, 2);
  assert.equal(limiter.windows.has('a'), false);
});

test('Limiter : les tâches de fond passent après les autres', async () => {
  const limiter = new Limiter(1);
  const order = [];
  const task = (name) => async () => {
    await sleep(2);
    order.push(name);
  };
  await Promise.all([
    limiter.run(task('en cours')),
    limiter.run(task('fond 1'), { background: true }),
    limiter.run(task('fond 2'), { background: true }),
    limiter.run(task('interactif')),
  ]);
  assert.deepEqual(order, ['en cours', 'interactif', 'fond 1', 'fond 2']);
  assert.equal(limiter.active, 0);
});

/** Parcours qui reste en cours jusqu'à `release()`. */
function blockedJob() {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  return {
    release,
    job: {
      loadPage: async () => {
        await gate;
        return { items: [], pagination: { totalResults: 0, totalPages: 0 } };
      },
      keep: () => true,
      enrich: null,
    },
  };
}

test('Collector refuse un parcours de plus par client, puis au total', async () => {
  const collector = new Collector();
  const blocked = blockedJob();
  const start = (key, owner) => collector.ensure(key, blocked.job, 9, { owner });

  const runs = [start('k1', 'ip-a'), start('k2', 'ip-a')];
  await assert.rejects(start('k3', 'ip-a'), (err) => err.status === 429 && err.retryAfter === 5);

  runs.push(start('k4', 'ip-b'), start('k5', 'ip-b'));
  assert.equal(CONFIG.maxActiveScans, 4);
  await assert.rejects(start('k6', 'ip-c'), (err) => err.status === 503 && err.retryAfter === 5);

  // Rejoindre un parcours déjà en cours reste permis.
  const joined = start('k1', 'ip-c');
  blocked.release();
  await Promise.all([...runs, joined]);

  // Les places sont rendues.
  await start('k6', 'ip-c');
});


test('Collector : un parcours que son client a quitté s’arrête et lui rend sa place', async () => {
  const collector = new Collector();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  // Source sans fin : seul le départ du client (ou le plafond de pages) arrête le parcours.
  const job = {
    loadPage: async (page) => {
      await gate;
      return { items: [{ domain: `d${page}.fr` }], pagination: { totalResults: 999, totalPages: 999 } };
    },
    keep: () => false,
    enrich: null,
  };
  const left = new AbortController();
  const start = (key, signal) => collector.ensure(key, job, 9, { owner: 'ip-a', signal });

  const runs = [start('k1', left.signal), start('k2')];
  await assert.rejects(start('k3'), (err) => err.status === 429);

  // Le client abandonne k1 (il a changé un filtre) : tant que sa page en cours
  // n'est pas finie, le parcours compte encore pour lui.
  left.abort();
  await assert.rejects(start('k3'), (err) => err.status === 429);

  release();
  await Promise.all(runs);

  // k1 s'est arrêté après sa page en cours, sans être clos : il reprendra là si on le redemande.
  const abandoned = collector.peek('k1');
  assert.equal(abandoned.scannedPages, 1);
  assert.equal(abandoned.partial, true);
  assert.equal(abandoned.capped, false);
  assert.equal(abandoned.waiters, 0);
  // Les autres sont allés au bout du plafond de pages.
  assert.equal(collector.peek('k2').scannedPages, CONFIG.reviewMaxScanPages);
  assert.equal(collector.peek('k2').waiters, 0);

  // La place est rendue, et k1, redemandé, reprend à la page suivante.
  await start('k3');
  await start('k1');
  assert.equal(collector.peek('k1').scannedPages, CONFIG.reviewMaxScanPages);
});
