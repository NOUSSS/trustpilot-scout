import puppeteer from 'puppeteer-core';
import { CONFIG, findBrowser } from './config.js';

const ORIGIN = 'https://www.trustpilot.com';

/** Borne une promesse (les évaluations CDP peuvent rester pendantes). */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Un seul navigateur + un seul onglet réutilisé.
 * L'onglet sert de "sac à cookies" : il résout le challenge AWS WAF une fois,
 * puis toutes les pages sont récupérées par fetch() dans son contexte
 * (léger : pas de rendu DOM, pas de rechargement complet).
 */
export class BrowserSession {
  /** @param {{ launchBrowser?: (options: object) => Promise<any> }} [deps] remplacé par un faux dans les tests */
  constructor({
    launchBrowser = (options) => puppeteer.launch({ executablePath: findBrowser(), ...options }),
  } = {}) {
    this.launchBrowser = launchBrowser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tokenAt = 0;
    this.authPromise = null;
    this.launchPromise = null;
    /** Relève d'un contexte refusé : les nouvelles requêtes l'attendent au lieu d'y entrer. */
    this.resetPromise = null;
    /** Requêtes en cours dans l'onglet (promesses bornées) : on ne ferme pas l'onglet sous elles. */
    this.inflight = new Set();
    /** Change à chaque contexte fermé : une requête servie par un ancien contexte ne relance rien. */
    this.generation = 0;
  }

  get authenticated() {
    return Boolean(this.tokenAt) && Date.now() - this.tokenAt < 5 * 60 * 1000;
  }

  /** Lance le navigateur une seule fois, même si plusieurs requêtes arrivent ensemble. */
  launch() {
    if (!this.launchPromise) {
      this.launchPromise = this.startBrowser().finally(() => {
        this.launchPromise = null;
      });
    }
    return this.launchPromise;
  }

  async startBrowser() {
    const browser = await this.launchBrowser({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--no-first-run',
        '--disable-extensions',
        `--lang=${CONFIG.locale}`,
      ],
      protocolTimeout: 120000,
    });
    browser.on('disconnected', () => {
      // Un ancien navigateur qui se ferme ne doit pas effacer la session du nouveau.
      if (this.browser !== browser) return;
      this.browser = null;
      this.context = null;
      this.page = null;
      this.tokenAt = 0;
    });
    this.browser = browser;
  }

  async newPage() {
    if (!this.browser?.connected) await this.launch();
    if (!this.context) this.context = await this.browser.createBrowserContext();
    const page = await this.context.newPage();
    await page.setUserAgent({ userAgent: CONFIG.userAgent });
    await page.setExtraHTTPHeaders({ 'accept-language': CONFIG.locale });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page.setDefaultTimeout(CONFIG.fetchTimeoutMs);
    return page;
  }

  /**
   * Ouvre un contexte isolé (jar de cookies neuf), résout le challenge WAF
   * puis vérifie que le jeton fonctionne réellement.
   */
  async authenticate() {
    await this.dropContext();
    const page = await this.newPage();
    // Le contexte est gardé en variable : une déconnexion peut vider `this.context` en cours de route.
    const context = this.context;
    this.page = page;

    await withTimeout(
      page
        .goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: CONFIG.tokenTimeoutMs })
        .catch(() => {}),
      CONFIG.tokenTimeoutMs + 3000
    );

    const deadline = Date.now() + CONFIG.tokenTimeoutMs;
    let token = null;
    while (Date.now() < deadline) {
      const cookies = await context.cookies().catch(() => []);
      token = cookies.find(
        (c) => c.name === 'aws-waf-token' && (!c.expires || c.expires * 1000 > Date.now())
      );
      if (token) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!token) throw new Error('Challenge AWS WAF non résolu');

    // Contrôle : le jeton est réellement accepté par l'API interne.
    // Le WAF peut répondre 403 quelques instants après avoir posé le cookie.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 500 : 1000));
      const ok = await page
        .evaluate(async () => {
          const res = await fetch('/search?query=test', { cache: 'no-store', credentials: 'include' });
          return res.status === 200;
        })
        .catch(() => false);
      if (ok) {
        this.tokenAt = Date.now();
        return;
      }
    }
    throw new Error('Jeton WAF posé mais refusé');
  }

  /** Attend la fin des requêtes en cours dans l'onglet, y compris celles parties entre-temps. */
  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  async dropContext() {
    // Fermer l'onglet sous un fetch en cours le fait échouer (« Target closed ») :
    // chaque requête est déjà bornée, on la laisse finir.
    await this.drain();
    this.tokenAt = 0;
    const page = this.page;
    const context = this.context;
    this.page = null;
    this.context = null;
    if (page || context) this.generation++;
    // La fermeture peut rester bloquée si un fetch est en cours : on borne.
    await withTimeout(page?.close().catch(() => {}), 4000);
    await withTimeout(context?.close().catch(() => {}), 4000);
  }

  /**
   * Abandonne le contexte de la génération donnée, une fois ses requêtes en
   * cours terminées. Sans effet si une autre requête l'a déjà fait ou si une
   * authentification est en cours : plusieurs refus ne relancent la session
   * qu'une fois.
   */
  async resetAuth(generation = this.generation) {
    if (generation !== this.generation || this.authPromise) return;
    if (!this.resetPromise) {
      this.resetPromise = this.dropContext().finally(() => {
        this.resetPromise = null;
      });
    }
    await this.resetPromise;
  }

  async ensureReady() {
    while (this.resetPromise) await this.resetPromise;
    if (!this.browser?.connected) {
      await this.launch();
      this.tokenAt = 0;
    }
    // Pendant une authentification, l'ancien onglet se vide : on n'y envoie plus rien.
    if (this.authPromise || !this.page || !this.authenticated) {
      if (!this.authPromise) {
        this.authPromise = this.authenticate().finally(() => {
          this.authPromise = null;
        });
      }
      await this.authPromise;
    }
  }

  /**
   * Récupère le HTML d'une page Trustpilot, avec la génération de session qui l'a servie.
   * @param {string} urlpath chemin commençant par "/"
   * @returns {Promise<{ html: string, generation: number }>}
   */
  async fetchPage(urlpath) {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.ensureReady();
      } catch (err) {
        lastError = err;
        console.warn('[auth] échec:', err.message);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      const page = this.page;
      const generation = this.generation;
      if (!page) continue;
      try {
        const request = withTimeout(
          page.evaluate(
            async (url, timeout) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeout);
              try {
                const res = await fetch(url, {
                  headers: { accept: 'text/html,application/xhtml+xml' },
                  signal: controller.signal,
                  credentials: 'include',
                });
                const text = await res.text();
                return { status: res.status, text };
              } finally {
                clearTimeout(timer);
              }
            },
            urlpath,
            CONFIG.fetchTimeoutMs
          ),
          CONFIG.fetchTimeoutMs + 5000
        );
        this.inflight.add(request);
        const result = await request.finally(() => this.inflight.delete(request));

        if (!result) throw new Error('Délai de récupération dépassé');

        if (result.status === 200) {
          // Une réponse d'un ancien contexte ne dit rien du jeton courant.
          if (generation === this.generation) this.tokenAt = Date.now();
          return { html: result.text, generation };
        }
        // 202 : challenge AWS WAF servi à la place de la page.
        if ([202, 403, 429, 503].includes(result.status)) {
          lastError = new Error(`Trustpilot a répondu ${result.status}`);
          // Le statut seul : le chemin peut contenir la recherche d'un utilisateur.
          console.warn('[fetch] refus', result.status, 'à la tentative', attempt + 1, ': nouvelle session');
          await this.resetAuth(generation);
          continue;
        }
        const err = new Error(`Trustpilot a répondu ${result.status}`);
        err.status = result.status;
        throw err;
      } catch (err) {
        lastError = err;
        if (err.status && err.status !== 429 && err.status !== 503) throw err;
        console.warn('[fetch] tentative', attempt + 1, 'échouée:', err.message);
        await this.resetAuth(generation);
      }
    }
    const err = new Error(
      `Trustpilot injoignable après plusieurs tentatives${lastError ? ` (${lastError.message})` : ''}`
    );
    err.status = 503;
    throw err;
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }

  get status() {
    return {
      browser: Boolean(this.browser?.connected),
      page: Boolean(this.page),
      authenticated: this.authenticated,
    };
  }
}

export const session = new BrowserSession();
