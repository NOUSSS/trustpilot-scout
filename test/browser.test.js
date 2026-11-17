import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session branchée sur un faux navigateur. `respond(url)` joue Trustpilot et
 * renvoie `{ status, text }` au bout de `delay(url)` ms. `stats` compte les
 * lancements, les onglets de l'accueil (`pages`, `opened` : un par
 * authentification), les onglets inertes (`tabs`), les requêtes envoyées par
 * chemin et celles coupées par la fermeture de l'onglet. Chaque onglet note les
 * chemins qu'il a servis (`served`) et les contrôles du jeton (`probes`).
 * `fetchTabGoto(tab)` s'exécute au chargement de chaque onglet inerte : il peut
 * le faire échouer ou traîner.
 */
function fakeSession(
  respond = (url) => ({ status: 200, text: `page ${url}` }),
  { delay = () => 30, sessionTtlMs, fetchTabTimeoutMs, fetchTabGoto = async () => {} } = {}
) {
  const stats = {
    launches: 0,
    pages: 0,
    opened: [],
    tabs: [],
    browsers: [],
    calls: {},
    closedUnder: 0,
  };
  const cookies = async () => [{ name: 'aws-waf-token', expires: 0 }];

  // Le premier onglet d'un contexte est celui de l'accueil, les suivants sont inertes.
  const createBrowserContext = async () => {
    let count = 0;
    const newPage = async () => {
      const home = count++ === 0;
      const page = {
        closed: false,
        intercepting: false,
        listeners: {},
        document: null,
        served: [],
        probes: 0,
        async setUserAgent() {},
        async setExtraHTTPHeaders() {},
        async evaluateOnNewDocument() {},
        setDefaultTimeout() {},
        async setRequestInterception(enabled) {
          page.intercepting = enabled;
        },
        once(event, listener) {
          page.listeners[event] = listener;
        },
        async goto(url) {
          // Accueil : le faux ne joue pas la navigation.
          if (!page.intercepting) return;
          await fetchTabGoto(page);
          // Requête interceptée : seule une réponse donnée par l'écouteur charge le document.
          const listener = page.listeners.request;
          delete page.listeners.request;
          let response = null;
          listener?.({
            url: () => url,
            async respond(r) {
              response = r;
            },
          });
          if (!response) throw new Error('Navigation timeout: requête interceptée sans réponse');
          page.document = { url, ...response };
        },
        cookies,
        async evaluate(fn, url) {
          // Sans URL : contrôle du jeton pendant l'authentification.
          if (url === undefined) {
            page.probes++;
            return true;
          }
          // Interception restée active : le fetch resterait suspendu.
          if (page.intercepting) throw new Error('fetch bloqué par l’interception');
          if (!home && !page.document) throw new Error('onglet inerte sans document');
          stats.calls[url] = (stats.calls[url] ?? 0) + 1;
          page.served.push(url);
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
      if (home) {
        stats.pages++;
        stats.opened.push(page);
      } else {
        stats.tabs.push(page);
      }
      return page;
    };
    return { newPage, cookies, async close() {} };
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
      createBrowserContext,
    };
    stats.browsers.push(browser);
    return browser;
  };

  return {
    session: new BrowserSession({ launchBrowser, sessionTtlMs, fetchTabTimeoutMs }),
    stats,
  };
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

test('un onglet resté sans requête se ferme une fois le jeton périmé', async () => {
  const { session, stats } = fakeSession(undefined, { sessionTtlMs: 100 });
  await session.fetchPage('/a');
  assert.equal(stats.opened[0].closed, false);
  await sleep(160);
  assert.equal(stats.opened[0].closed, true);
  assert.equal(session.status.page, false);
  // La requête suivante rouvre un onglet, sans relancer le navigateur.
  assert.equal((await session.fetchPage('/b')).html, 'page /b');
  assert.equal(stats.pages, 2);
  assert.equal(stats.launches, 1);
});

test('une requête réussie repousse la fermeture de l’onglet', async () => {
  const { session, stats } = fakeSession(undefined, { sessionTtlMs: 150, delay: () => 5 });
  await session.fetchPage('/a');
  await sleep(100);
  await session.fetchPage('/b');
  await sleep(100);
  assert.equal(stats.opened[0].closed, false);
  await sleep(120);
  assert.equal(stats.opened[0].closed, true);
  assert.equal(stats.pages, 1);
});

test('la fermeture attend la requête en vol', async () => {
  const delays = { '/lent': 250 };
  const { session, stats } = fakeSession(undefined, {
    sessionTtlMs: 100,
    delay: (url) => delays[url] ?? 5,
  });
  await session.fetchPage('/warm');
  // /lent part avant la péremption et finit après : l’onglet ne se ferme pas sous elle.
  await sleep(60);
  const lent = await session.fetchPage('/lent');
  assert.equal(lent.html, 'page /lent');
  assert.equal(stats.closedUnder, 0);
  assert.equal(stats.opened[0].closed, false);
  await sleep(160);
  assert.equal(stats.opened[0].closed, true);
});

test('un onglet dont l’authentification échoue se ferme aussi', async () => {
  const { session, stats } = fakeSession(undefined, { sessionTtlMs: 100 });
  // Aucun jeton WAF : l’authentification échoue, l’onglet reste ouvert sur l’accueil.
  session.authenticate = async function () {
    await this.dropContext();
    this.page = await this.newPage();
    this.armIdleClose(this.sessionTtlMs);
    throw new Error('Challenge AWS WAF non résolu');
  };
  await assert.rejects(session.ensureReady());
  assert.equal(stats.opened[0].closed, false);
  await sleep(160);
  assert.equal(stats.opened[0].closed, true);
});

test('un minuteur parti avant l’échéance repasse au lieu d’abandonner', async () => {
  const { session, stats } = fakeSession(undefined, { sessionTtlMs: 100 });
  await session.fetchPage('/a');
  // Le minuteur part alors que le jeton vaut encore quelques millisecondes.
  session.tokenAt = Date.now() - 95;
  await session.closeIfIdle();
  assert.equal(stats.opened[0].closed, false);
  await sleep(40);
  assert.equal(stats.opened[0].closed, true);
});

test('les requêtes partent de l’onglet inerte, le contrôle du jeton de l’accueil', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { session, stats } = fakeSession();
  await fetchAll(session, ['/a', '/b']);
  const [home] = stats.opened;
  const [tab] = stats.tabs;
  assert.equal(stats.tabs.length, 1);
  assert.equal(session.fetchTab, tab);
  assert.deepEqual([...tab.served].sort(), ['/a', '/b']);
  assert.deepEqual(home.served, []);
  assert.ok(home.probes >= 1);
  assert.equal(tab.probes, 0);
  // Document vide servi localement à l'adresse de l'accueil, interception coupée ensuite.
  assert.equal(tab.document.url, 'https://www.trustpilot.com/');
  assert.equal(tab.document.status, 200);
  assert.equal(tab.intercepting, false);
  assert.equal(home.closed, false);
  assert.deepEqual(warnings, []);
});

test('si l’onglet inerte ne s’ouvre pas, les requêtes passent par l’accueil', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { session, stats } = fakeSession(undefined, {
    fetchTabGoto: async () => {
      throw new Error('net::ERR_FAILED');
    },
  });
  assert.equal((await session.fetchPage('/a')).html, 'page /a');
  assert.equal(session.status.authenticated, true);
  assert.equal(session.fetchTab, null);
  assert.deepEqual(stats.opened[0].served, ['/a']);
  // L'onglet à moitié ouvert est fermé.
  assert.equal(stats.tabs[0].closed, true);
  assert.deepEqual(stats.tabs[0].served, []);
  assert.equal(stats.pages, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /repli/);
});

test('un onglet inerte trop lent est abandonné, puis fermé une fois ouvert', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { session, stats } = fakeSession(undefined, {
    fetchTabTimeoutMs: 20,
    fetchTabGoto: () => sleep(200),
  });
  assert.equal((await session.fetchPage('/a')).html, 'page /a');
  assert.equal(session.fetchTab, null);
  assert.deepEqual(stats.opened[0].served, ['/a']);
  assert.equal(stats.tabs[0].closed, false);
  await sleep(250);
  assert.equal(stats.tabs[0].closed, true);
  assert.equal(session.fetchTab, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lente/);
});

test('l’onglet inerte se ferme avec le contexte, une nouvelle authentification en rouvre un', async () => {
  const { session, stats } = fakeSession(undefined, { sessionTtlMs: 100, delay: () => 5 });
  const { generation } = await session.fetchPage('/a');
  await session.resetAuth(generation);
  assert.equal(stats.tabs[0].closed, true);
  assert.equal(session.fetchTab, null);

  await session.fetchPage('/b');
  assert.equal(stats.tabs.length, 2);
  assert.equal(stats.tabs[1].closed, false);
  assert.deepEqual(stats.tabs[1].served, ['/b']);
  assert.equal(session.fetchTab, stats.tabs[1]);

  // Jeton périmé : l'onglet inerte part avec celui de l'accueil.
  await sleep(160);
  assert.equal(stats.opened[1].closed, true);
  assert.equal(stats.tabs[1].closed, true);
  assert.equal(session.fetchTab, null);

  await session.fetchPage('/c');
  assert.equal(stats.tabs.length, 3);
  assert.deepEqual(stats.tabs[2].served, ['/c']);
  assert.equal(stats.launches, 1);
});

test('une déconnexion du navigateur oublie l’onglet inerte', async () => {
  const { session, stats } = fakeSession();
  await session.fetchPage('/a');
  assert.equal(session.fetchTab, stats.tabs[0]);
  const [browser] = stats.browsers;
  browser.connected = false;
  browser.listeners.disconnected();
  assert.equal(session.fetchTab, null);
  assert.equal(session.page, null);
  await session.fetchPage('/b');
  assert.equal(stats.launches, 2);
  assert.deepEqual(stats.tabs[1].served, ['/b']);
});

test('un onglet inerte ouvert pendant une déconnexion n’est pas installé', async () => {
  let disconnected = false;
  const { session, stats } = fakeSession(undefined, {
    fetchTabGoto: async () => {
      if (disconnected) return;
      disconnected = true;
      const [browser] = stats.browsers;
      browser.connected = false;
      browser.listeners.disconnected();
    },
  });
  assert.equal((await session.fetchPage('/a')).html, 'page /a');
  assert.equal(stats.launches, 2);
  assert.deepEqual(stats.tabs[0].served, []);
  assert.equal(stats.tabs[0].closed, true);
  assert.deepEqual(stats.tabs[1].served, ['/a']);
  assert.equal(session.fetchTab, stats.tabs[1]);
});

test('un 403 parmi trois requêtes en vol relance une fois, onglet inerte compris', async () => {
  let failures = 0;
  const { session, stats } = fakeSession(
    (url) => {
      if (url === '/b' && failures++ === 0) return { status: 403, text: '' };
      return { status: 200, text: `page ${url}` };
    },
    { delay: (url) => (url === '/b' ? 10 : 80) }
  );
  const { generation } = await session.fetchPage('/warm');

  const [a, b, c] = await fetchAll(session, ['/a', '/b', '/c']);
  assert.deepEqual([a.html, b.html, c.html], ['page /a', 'page /b', 'page /c']);
  assert.deepEqual([a.generation, b.generation, c.generation], [generation, generation + 1, generation]);
  assert.equal(stats.closedUnder, 0);
  assert.equal(stats.pages, 2);
  assert.equal(stats.tabs.length, 2);
  // L'ancien onglet inerte a servi /a, /b (refusée) et /c, puis s'est fermé ; le neuf sert /b.
  assert.deepEqual([...stats.tabs[0].served].sort(), ['/a', '/b', '/c', '/warm']);
  assert.equal(stats.tabs[0].closed, true);
  assert.deepEqual(stats.tabs[1].served, ['/b']);
  assert.equal(stats.tabs[1].closed, false);
  assert.deepEqual(stats.opened.map((home) => home.served), [[], []]);
});
