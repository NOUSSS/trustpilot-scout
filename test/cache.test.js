import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, Limiter, cached, prefetch } from '../src/cache.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('TtlCache garde et rend une valeur', () => {
  const cache = new TtlCache({ ttlMs: 60000, maxEntries: 10 });
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 1);
});

test('TtlCache oublie une entrée expirée', () => {
  // TTL négatif : l'entrée est déjà expirée à la lecture, sans attendre.
  const cache = new TtlCache({ ttlMs: -1, maxEntries: 10 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('TtlCache évince l’entrée la moins récemment lue', () => {
  const cache = new TtlCache({ ttlMs: 60000, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('Limiter borne les exécutions simultanées', async () => {
  const limiter = new Limiter(2);
  let active = 0;
  let peak = 0;
  const task = (value) => async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return value;
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limiter.run(task(n))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test('Limiter libère la place d’une tâche en erreur', async () => {
  const limiter = new Limiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limiter.run(async () => 'ok'), 'ok');
  assert.equal(limiter.active, 0);
});

test('cached : un seul téléchargement, puis le cache', async () => {
  const cache = new TtlCache({ ttlMs: 60000, maxEntries: 10 });
  const limiter = new Limiter(3);
  let calls = 0;
  const task = async () => {
    calls++;
    await sleep(5);
    return 'page';
  };
  const [first, second] = await Promise.all([
    cached(cache, limiter, 'k', task),
    cached(cache, limiter, 'k', task),
  ]);
  assert.deepEqual(first, { value: 'page', hit: false, shared: false });
  assert.deepEqual(second, { value: 'page', hit: false, shared: true });
  assert.deepEqual(await cached(cache, limiter, 'k', task), { value: 'page', hit: true, shared: false });
  assert.equal(calls, 1);
});

test('cached ne met pas une erreur en cache', async () => {
  const cache = new TtlCache({ ttlMs: 60000, maxEntries: 10 });
  const limiter = new Limiter(3);
  let calls = 0;
  const task = async () => {
    calls++;
    if (calls === 1) throw new Error('503');
    return 'page';
  };
  await assert.rejects(cached(cache, limiter, 'k', task), /503/);
  assert.equal((await cached(cache, limiter, 'k', task)).value, 'page');
  assert.equal(calls, 2);
});

test('prefetch remplit le cache sans lever d’erreur', async () => {
  const cache = new TtlCache({ ttlMs: 60000, maxEntries: 10 });
  const limiter = new Limiter(3);
  prefetch(cache, limiter, 'bad', async () => { throw new Error('503'); });
  prefetch(cache, limiter, 'good', async () => 'page');
  await sleep(10);
  assert.equal(cache.get('bad'), undefined);
  assert.equal(cache.get('good'), 'page');
});
