import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session branchée sur un faux navigateur. `respond(url)` joue Trustpilot et
 * renvoie `{ status, text }` au bout de `delay(url)` ms. `stats` compte les
 * lancements, les onglets ouverts (un onglet ouvert = une authentification),
 * les requêtes envoyées par chemin et celles coupées par la fermeture de l'onglet.
 */
function fakeSession(
  respond = (url) => ({ status: 200, text: `page ${url}` }),
  { delay = () => 30 } = {}
) {
  const stats = { launches: 0, pages: 0, browsers: [], calls: {}, closedUnder: 0 };
  const cookies = async () => [{ name: 'aws-waf-token', expires: 0 }];

  const newPage = async () => {
    stats.pages++;
    const page = {
      closed: false,
      async setUserAgent() {},
      async setExtraHTTPHeaders() {},
      async evaluateOnNewDocument() {},
      setDefaultTimeout() {},
      async goto() {},
      cookies,
      async evaluate(fn, url) {
        // Sans URL : contrôle du jeton pendant l'authentification.
        if (url === undefined) return true;
        stats.calls[url] = (stats.calls[url] ?? 0) + 1;
        await sleep(delay(url));
        if (page.closed) {
          stats.closedUnder++;
          throw new Error('Protocol error (Runtime.callFunctionOn): Target closed');
        }
        return respond(url);
      },
      async close() {
        page.closed = true;
      },
    };
    return page;
  };

  const launchBrowser = async () => {
    stats.launches++;
    await sleep(20);
    const browser = {
      connected: true,
      listeners: {},
      on(event, listener) {
        this.listeners[event] = listener;
      },
      async close() {},
      async createBrowserContext() {
        return { newPage, cookies, async close() {} };
      },
    };
    stats.browsers.push(browser);
    return browser;
  };

  return { session: new BrowserSession({ launchBrowser }), stats };
}

/** Répond `status` à la première requête, puis 200. */
function failingOnce(status) {
  let failed = false;
  return (url) => {
    if (failed) return { status: 200, text: `page ${url}` };
    failed = true;
    return { status, text: '' };
  };
}

const fetchAll = (session, paths) => Promise.all(paths.map((p) => session.fetchPage(p)));

test('trois requêtes à froid : un navigateur, une authentification', async () => {
  const { session, stats } = fakeSession();
  const pages = await fetchAll(session, ['/a', '/b', '/c']);
  assert.deepEqual(pages.map((p) => p.html), ['page /a', 'page /b', 'page /c']);
  assert.equal(stats.launches, 1);
  assert.equal(stats.pages, 1);
  assert.equal(session.status.authenticated, true);
});

test('un 403 parmi trois requêtes en vol : une seule réauthentification', async () => {
  let failures = 0;
  const { session, stats } = fakeSession((url) => {
    // Seule la première requête pour /b reçoit un 403.
    if (url === '/b' && failures++ === 0) return { status: 403, text: '' };
    return { status: 200, text: `page ${url}` };
  });
  await session.fetchPage('/warm');
  assert.equal(stats.pages, 1);

  const pages = await fetchAll(session, ['/a', '/b', '/c']);
  assert.deepEqual(pages.map((p) => p.html), ['page /a', 'page /b', 'page /c']);
  assert.equal(stats.pages, 2);
  assert.equal(stats.launches, 1);
});

test('deux requêtes en vol survivent au 403 d’une troisième', async () => {
  let failures = 0;
  const { session, stats } = fakeSession(
    (url) => {
      if (url === '/b' && failures++ === 0) return { status: 403, text: '' };
      return { status: 200, text: `page ${url}` };
    },
    // Le refus arrive pendant que /a et /c attendent encore leur réponse.
    { delay: (url) => (url === '/b' ? 10 : 80) }
  );
  const { generation } = await session.fetchPage('/warm');

  const [a, b, c] = await fetchAll(session, ['/a', '/b', '/c']);
  assert.equal(stats.closedUnder, 0);
  assert.deepEqual([a.html, b.html, c.html], ['page /a', 'page /b', 'page /c']);
  // /a et /c sont servies du premier coup par l'ancien onglet, /b par le nouveau.
  assert.equal(stats.calls['/a'], 1);
  assert.equal(stats.calls['/c'], 1);
  assert.equal(stats.calls['/b'], 2);
  assert.deepEqual([a.generation, b.generation, c.generation], [generation, generation + 1, generation]);
  assert.equal(stats.pages, 2);
});

test('une requête arrivée pendant la relève attend le nouvel onglet', async () => {
  let failures = 0;
  const { session, stats } = fakeSession(
    (url) => {
      if (url === '/b' && failures++ === 0) return { status: 403, text: '' };
      return { status: 200, text: `page ${url}` };
    },
    { delay: (url) => (url === '/a' ? 100 : 10) }
  );
  const { generation } = await session.fetchPage('/warm');

  const pending = fetchAll(session, ['/a', '/b']);
  // /b a été refusée, /a est encore en vol sur l'ancien onglet.
  await sleep(40);
  const d = await session.fetchPage('/d');
  const [a, b] = await pending;
  assert.equal(stats.closedUnder, 0);
  assert.equal(stats.calls['/d'], 1);
  assert.equal(a.generation, generation);
  assert.equal(b.generation, generation + 1);
  assert.equal(d.generation, generation + 1);
  assert.equal(stats.pages, 2);
});

test('un jeton expiré attend la fin des requêtes en vol avant de fermer l’onglet', async () => {
  const delays = { '/a': 40, '/e': 120 };
  const { session, stats } = fakeSession(undefined, { delay: (url) => delays[url] ?? 10 });
  const { generation } = await session.fetchPage('/warm');

  const inFlight = fetchAll(session, ['/a', '/e']);
  await sleep(5);
  session.tokenAt = Date.now() - 6 * 60 * 1000;
  const b = session.fetchPage('/b');
  // La réponse de /a a rafraîchi le jeton, /e est encore en vol : /c doit attendre le nouvel onglet.
  await sleep(55);
  const c = session.fetchPage('/c');
  const [[a, e], pb, pc] = await Promise.all([inFlight, b, c]);
  assert.equal(stats.closedUnder, 0);
  assert.deepEqual(
    [a.generation, e.generation, pb.generation, pc.generation],
    [generation, generation, generation + 1, generation + 1]
  );
  assert.equal(stats.calls['/c'], 1);
  assert.equal(stats.pages, 2);
});

test('un refus est journalisé avec son statut, sans le chemin', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { session } = fakeSession(failingOnce(429));
  await session.fetchPage('/search?query=secret');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /429/);
  assert.doesNotMatch(warnings[0], /secret/);
});

test('un challenge servi en 202 relance la session', async () => {
  const { session, stats } = fakeSession(failingOnce(202));
  assert.equal((await session.fetchPage('/a')).html, 'page /a');
  assert.equal(stats.pages, 2);
});

test('une erreur définitive remonte sans relancer la session', async () => {
  const { session, stats } = fakeSession(() => ({ status: 404, text: '' }));
  await assert.rejects(session.fetchPage('/a'), (err) => err.status === 404);
  assert.equal(stats.pages, 1);
});

test('Trustpilot refuse trois fois : 503 explicite', async () => {
  const { session } = fakeSession(() => ({ status: 403, text: '' }));
  await assert.rejects(session.fetchPage('/a'), (err) => err.status === 503);
});

test('fetchPage rend la génération qui a servi la page', async () => {
  const { session } = fakeSession();
  const first = await session.fetchPage('/a');
  assert.equal(first.generation, session.generation);
  await session.resetAuth(first.generation);
  assert.equal(session.page, null);
  const second = await session.fetchPage('/b');
  assert.equal(second.generation, first.generation + 1);
});

test('resetAuth d’une ancienne génération est sans effet', async () => {
  const { session, stats } = fakeSession();
  const { generation } = await session.fetchPage('/a');
  await session.resetAuth(generation - 1);
  assert.notEqual(session.page, null);
  await session.fetchPage('/b');
  assert.equal(stats.pages, 1);
});

test('la fermeture d’un ancien navigateur n’efface pas la session du nouveau', async () => {
  const { session, stats } = fakeSession();
  await session.fetchPage('/a');
  const [old] = stats.browsers;
  // Plantage : le navigateur n'est plus joignable, l'évènement n'est pas encore parti.
  old.connected = false;
  await session.fetchPage('/b');
  assert.equal(stats.launches, 2);
  old.listeners.disconnected();
  assert.equal(session.browser, stats.browsers[1]);
  assert.notEqual(session.page, null);
  assert.equal(session.status.authenticated, true);
});
