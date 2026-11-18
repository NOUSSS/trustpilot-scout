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

/** Promesse libérée à la main par le test. */
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

/** Laisse passer une macrotâche : tout ce qui pouvait avancer a avancé (et un rejet non géré éclaterait ici). */
const tick = () => sleep(0);

/** Attend la fin du parcours en cours, sans passer par `ensure`. */
const settled = async (state) => {
  while (state.running) await sleep(1);
  await tick();
};

/** Source de `pages` pages de `size` entreprises nommées `p<n>-<i>.com`, qui note les pages lues. */
const pagedSource = (pages, size, calls) => async (n) => {
  calls.push(n);
  return {
    items: Array.from({ length: size }, (_, i) => ({ domain: `p${n}-${i}.com`, reviews: 5 })),
    pagination: { totalResults: pages * size, totalPages: pages },
  };
};

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

test('Collector : l’ordre de la source est tenu quand les fiches se résolvent dans le désordre', async () => {
  const collector = new Collector();
  const gates = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((d) => [`${d}.com`, deferred()]));
  const job = {
    loadPage: onePage(...Object.keys(gates)),
    keep: () => true,
    enrich: async (b) => {
      await gates[b.domain].promise;
      // c.com n'a aucune correspondance.
      return b.domain === 'c.com' ? null : { ...b, matchCount: 1 };
    },
  };
  const request = collector.ensure('k', job, 9);
  await tick();
  const state = collector.peek('k');
  const domains = () => state.hits.map((h) => h.domain);

  // Résolues avant a.com : rien n'est poussé, l'ordre de la source passe avant la vitesse.
  gates['e.com'].resolve();
  gates['c.com'].resolve();
  await tick();
  assert.deepEqual(domains(), []);
  // a.com lue : le préfixe a.com seul est poussé, b.com bloque encore la suite.
  gates['a.com'].resolve();
  await tick();
  assert.deepEqual(domains(), ['a.com']);
  gates['d.com'].resolve();
  await tick();
  assert.deepEqual(domains(), ['a.com']);
  gates['b.com'].resolve();
  await request;
  assert.deepEqual(domains(), ['a.com', 'b.com', 'd.com', 'e.com']);
});

test('Collector : une requête revient avant la fin de la page dès que ses résultats sont là', async () => {
  const collector = new Collector();
  const calls = [];
  const blocked = deferred();
  const enriched = [];
  const job = {
    loadPage: pagedSource(1, 5, calls),
    keep: () => true,
    enrich: async (b) => {
      enriched.push(b.domain);
      // La dernière fiche de la page reste bloquée jusqu'à la fin du test.
      if (b.domain === 'p1-4.com') await blocked.promise;
      return { ...b, matchCount: 1 };
    },
  };
  // Celle qui lance le parcours et celle qui le rejoint reviennent toutes deux sans attendre p1-4.com.
  const launcher = collector.ensure('k', job, 3);
  const joiner = collector.ensure('k', job, 4);
  const early = await Promise.race([
    Promise.all([launcher, joiner]),
    sleep(200).then(() => 'bloquée'),
  ]);
  assert.notEqual(early, 'bloquée');
  const [state, joined] = early;
  assert.equal(state, joined);
  assert.ok(state.running, 'le parcours finit sa page sans les requêtes');
  assert.deepEqual(state.hits.map((h) => h.domain), ['p1-0.com', 'p1-1.com', 'p1-2.com', 'p1-3.com']);
  assert.equal(state.waiters, 0);

  blocked.resolve();
  await settled(state);
  assert.equal(state.hits.length, 5);
  assert.deepEqual(calls, [1]);
  assert.equal(enriched.length, 5);
  // Plus rien d'accroché à l'état une fois les requêtes revenues.
  assert.equal(state.wakers.size, 0);
  assert.equal(state.waiters, 0);
});

test('Collector : la requête suivante reprend sans relire de page ni de fiche', async () => {
  const collector = new Collector();
  const calls = [];
  const blocked = deferred();
  const enriched = [];
  const job = {
    loadPage: pagedSource(3, 3, calls),
    keep: () => true,
    enrich: async (b) => {
      enriched.push(b.domain);
      if (b.domain === 'p1-2.com') await blocked.promise;
      return { ...b, matchCount: 1 };
    },
  };
  const state = await collector.ensure('k', job, 2);
  assert.ok(state.running);
  assert.deepEqual(state.hits.map((h) => h.domain), ['p1-0.com', 'p1-1.com']);

  // Elle en veut plus : elle attend que le parcours en cours finisse sa page, puis le prolonge.
  const next = collector.ensure('k', job, 5);
  const waiting = await Promise.race([next, sleep(20).then(() => 'en attente')]);
  assert.equal(waiting, 'en attente');
  blocked.resolve();
  const after = await next;
  assert.equal(after, state);
  await settled(state);

  const domains = state.hits.map((h) => h.domain);
  assert.deepEqual(domains, ['p1-0.com', 'p1-1.com', 'p1-2.com', 'p2-0.com', 'p2-1.com', 'p2-2.com']);
  assert.equal(new Set(domains).size, domains.length);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(enriched, domains);
  assert.equal(state.wakers.size, 0);
  assert.equal(state.waiters, 0);
});

test('Collector : les fiches en attente sont réessayées au tour suivant, dans l’ordre', async () => {
  const collector = new Collector();
  let down = true;
  const slow = deferred();
  const blocked = deferred();
  const calls = [];
  const job = {
    loadPage: onePage('a.com', 'b.com', 'c.com', 'd.com'),
    keep: () => true,
    enrich: async (b) => {
      calls.push(b.domain);
      if (down && (b.domain === 'b.com' || b.domain === 'd.com')) throw failure(503);
      if (down && b.domain === 'c.com') await slow.promise;
      if (!down && b.domain === 'b.com') await blocked.promise;
      return { ...b, matchCount: 1 };
    },
  };
  // Premier tour revenu en cours de page : b.com, qui précède c.com encore bloquée, est déjà en attente.
  const first = await collector.ensure('k', job, 1);
  await tick();
  assert.ok(first.running);
  assert.deepEqual(first.hits.map((h) => h.domain), ['a.com']);
  assert.deepEqual(first.pending.map((e) => e.business.domain), ['b.com']);
  slow.resolve();
  await settled(first);
  assert.deepEqual(first.hits.map((h) => h.domain), ['a.com', 'c.com']);
  assert.deepEqual(first.pending.map((e) => e.business.domain), ['b.com', 'd.com']);
  assert.equal(first.partial, true);

  // Les résultats suffisent déjà (2), mais des fiches sont en attente : la requête attend leurs essais.
  down = false;
  const second = collector.ensure('k', job, 2);
  const waiting = await Promise.race([second, sleep(20).then(() => 'en attente')]);
  assert.equal(waiting, 'en attente');
  // d.com est relue, mais b.com la précède : rien n'est poussé avant elle.
  assert.deepEqual(first.hits.map((h) => h.domain), ['a.com', 'c.com']);
  blocked.resolve();
  const state = await second;
  assert.deepEqual(state.hits.map((h) => h.domain), ['a.com', 'c.com', 'b.com', 'd.com']);
  assert.equal(state.pending.length, 0);
  assert.equal(state.partial, false);
  assert.deepEqual(calls, ['a.com', 'b.com', 'c.com', 'd.com', 'b.com', 'd.com']);
  assert.equal(state.wakers.size, 0);
});

test('Collector : la page suivante est préchargée pendant la lecture des fiches', async () => {
  const collector = new Collector();
  const log = [];
  const calls = [];
  const source = pagedSource(3, 2, calls);
  const job = {
    loadPage: async (n) => {
      log.push(`page ${n}`);
      return source(n);
    },
    keep: () => true,
    enrich: async (b) => {
      log.push(`fiche ${b.domain}`);
      await sleep(2);
      log.push(`lue ${b.domain}`);
      return { ...b, matchCount: 1 };
    },
    // Un préchargement qui échoue (tout de suite ou plus tard) ne change rien au parcours.
    preload: (n) => {
      log.push(`préchargement ${n}`);
      if (n === 2) throw failure(503);
      return Promise.reject(failure(503));
    },
  };
  const state = await collector.ensure('k', job, 600);
  await tick();

  assert.deepEqual(log.slice(0, 3), ['page 1', 'préchargement 2', 'fiche p1-0.com']);
  // Préchargement de la page 3 avant la fin des fiches de la page 2 ; aucun après la dernière.
  assert.ok(log.indexOf('préchargement 3') < log.indexOf('lue p2-0.com'));
  assert.deepEqual(log.filter((l) => l.startsWith('préchargement')), ['préchargement 2', 'préchargement 3']);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(state.hits.length, 6);
  assert.equal(state.exhausted, true);
  assert.equal(state.error, null);
});

test('Collector : le plafond compte les pages lues, pas les tours d’un continent', async () => {
  const collector = new Collector();
  const calls = [];
  // Chaque page de la source en lit 40 chez Trustpilot (40 pays) : le plafond de 100 tombe au 3e tour.
  const job = {
    loadPage: async (n) => {
      const payload = await pagedSource(10, 2, calls)(n);
      return { ...payload, pagination: { ...payload.pagination, sourcePages: 40 } };
    },
    keep: () => true,
  };
  const state = await collector.ensure('continent', job, 1000);
  await settled(state);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(state.sourcePages, 120);
  assert.equal(state.capped, true);
  assert.equal(state.exhausted, false);
});

test('Collector : une entreprise citée deux fois dans la même page ne compte qu’une fois', async () => {
  const collector = new Collector();
  const job = { loadPage: onePage('a.com', 'a.com', 'x.com'), keep: () => true };
  const state = await collector.ensure('doublons', job, 10);
  await settled(state);
  assert.deepEqual(state.hits.map((h) => h.domain), ['a.com', 'x.com']);
});

test('Collector : une page de continent abandonnée s’arrête entre deux lots de fiches', async () => {
  const collector = new Collector();
  const calls = [];
  const gate = deferred();
  const enriched = [];
  const job = {
    // 60 entreprises dans une seule page : trois lots de 20.
    loadPage: pagedSource(1, 60, calls),
    keep: () => true,
    enrich: async (b) => {
      enriched.push(b.domain);
      await gate.promise;
      return { ...b, matchCount: 1 };
    },
  };
  const controller = new AbortController();
  const request = collector.ensure('abandon', job, 100, { signal: controller.signal });
  await tick();
  assert.equal(enriched.length, 20);
  controller.abort();
  gate.resolve();
  const state = await request;
  await settled(state);
  assert.equal(enriched.length, 20);
  assert.equal(state.hits.length, 20);
  assert.equal(state.pending.length, 0);
  assert.equal(state.deferred.length, 40);
  assert.equal(state.deferred[0].tries, 0);
  assert.equal(state.partial, true);
  // Examinées : les fiches parties à la lecture, pas celles remises à plus tard.
  assert.equal(state.examined, 20);

  // La requête suivante lit la fin de la page avant d'en charger une autre.
  const next = await collector.ensure('abandon', job, 30);
  await settled(next);
  assert.deepEqual(calls, [1]);
  assert.equal(enriched.length, 40);
  assert.equal(next.hits.length, 40);
  assert.equal(next.deferred.length, 20);
  assert.equal(next.examined, 40);
  assert.equal(next.hits[20].domain, 'p1-20.com');
});

test('Collector : des résultats déjà là ne relancent pas la lecture des fiches remises à plus tard', async () => {
  const collector = new Collector();
  const enriched = [];
  const job = {
    loadPage: pagedSource(1, 60, []),
    keep: () => true,
    enrich: async (b) => {
      enriched.push(b.domain);
      return { ...b, matchCount: 1 };
    },
  };
  const state = collector.state('déjà-là');
  state.hits = Array.from({ length: 10 }, (_, i) => ({ domain: `h${i}.com` }));
  state.deferred = [{ business: { domain: 'd.com', reviews: 5 }, tries: 0 }];
  state.scannedPages = 1;
  state.exhausted = true;
  const t0 = Date.now();
  await collector.ensure('déjà-là', job, 9);
  assert.equal(state.running, null);
  assert.deepEqual(enriched, []);
  assert.ok(Date.now() - t0 < 100);
});
