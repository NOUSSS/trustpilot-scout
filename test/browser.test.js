import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session branchée sur un faux navigateur. `respond(url)` joue Trustpilot et
 * renvoie `{ status, text }`. `stats` compte les lancements et les onglets
 * ouverts (un onglet ouvert = une authentification).
 */
function fakeSession(respond = (url) => ({ status: 200, text: `page ${url}` })) {
  const stats = { launches: 0, pages: 0, browsers: [] };
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
        await sleep(30);
        if (page.closed) throw new Error('Target closed');
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
