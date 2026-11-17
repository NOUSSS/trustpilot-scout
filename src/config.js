import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Nombre lu dans l'environnement. Variable absente ou vide : le défaut.
 * Valeur non numérique ou sous le minimum : le défaut aussi, avec un
 * avertissement (une faute de frappe ne doit pas lever une limite).
 */
export function envNumber(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return value;
  console.warn(`[config] ${name} invalide (${raw}), valeur par défaut utilisée:`, fallback);
  return fallback;
}

export const CONFIG = {
  port: envNumber('PORT', 8787),
  host: process.env.HOST || '127.0.0.1',
  userAgent: UA,
  locale: process.env.TP_LOCALE || 'en-US',
  /** Durée de vie du cache des pages de résultats. */
  cacheTtlMs: envNumber('TP_CACHE_TTL_MS', 10 * 60 * 1000),
  cacheMaxEntries: envNumber('TP_CACHE_MAX', 600, 1),
  /** Nombre de requêtes simultanées vers Trustpilot. */
  maxConcurrency: envNumber('TP_CONCURRENCY', 3, 1),
  /** Durée maximale d'un fetch de page (ms). */
  fetchTimeoutMs: envNumber('TP_FETCH_TIMEOUT_MS', 15000, 1),
  tokenTimeoutMs: 25000,

  /** Recherche dans les avis : bornes de scan. */
  reviewPerPage: 8,
  reviewMaxScanPages: envNumber('TP_SCAN_MAX_PAGES', 100, 1),
  reviewScanBudgetMs: envNumber('TP_SCAN_BUDGET_MS', 20000),
  reviewMaxHits: envNumber('TP_SCAN_MAX_HITS', 600, 1),
  reviewSnippets: 3,
  reviewStateTtlMs: 10 * 60 * 1000,
  reviewStateMax: 60,
  reviewCacheTtlMs: 15 * 60 * 1000,
  reviewCacheMax: 800,

  /** Garde-fous d'un déploiement public. */
  rateLimitPerMin: envNumber('TP_RATE_LIMIT_PER_MIN', 120),
  /** En-tête qui porte l'adresse du client derrière un proxy de confiance (ex. `cf-connecting-ip`). */
  clientIpHeader: (process.env.TP_CLIENT_IP_HEADER || '').toLowerCase(),
  maxActiveScans: envNumber('TP_MAX_ACTIVE_SCANS', 4, 1),
  maxScansPerClient: 2,
};

/** Recherche un binaire Chrome/Edge/Chromium utilisable. */
export function findBrowser() {
  const explicit = process.env.TP_BROWSER_PATH || process.env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  for (const full of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
  ]) {
    if (fs.existsSync(full)) return full;
  }

  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);

  const relative = [
    'Microsoft\\EdgeCore',
    'Microsoft\\Edge\\Application',
    'Google\\Chrome\\Application',
    'Google\\Chrome Beta\\Application',
    'Chromium\\Application',
  ];

  for (const root of roots) {
    for (const rel of relative) {
      const dir = path.join(root, rel);
      let versions;
      try {
        versions = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const sorted = versions
        .filter((v) => /^\d+\./.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of sorted) {
        for (const exe of ['msedge.exe', 'chrome.exe', 'Chromium.exe']) {
          const full = path.join(dir, version, exe);
          if (fs.existsSync(full)) return full;
        }
      }
      // Installation "flat" éventuelle.
      for (const exe of ['msedge.exe', 'chrome.exe']) {
        const full = path.join(dir, exe);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  throw new Error(
    'Aucun navigateur Chrome/Edge trouvé. Définis TP_BROWSER_PATH vers msedge.exe ou chrome.exe.'
  );
}
