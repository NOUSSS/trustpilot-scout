import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CONFIG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  userAgent: UA,
  locale: process.env.TP_LOCALE || 'en-US',
  /** Durée de vie du cache des pages de résultats. */
  cacheTtlMs: Number(process.env.TP_CACHE_TTL_MS || 10 * 60 * 1000),
  cacheMaxEntries: Number(process.env.TP_CACHE_MAX || 600),
  /** Nombre de requêtes simultanées vers Trustpilot. */
  maxConcurrency: Number(process.env.TP_CONCURRENCY || 3),
  /** Durée maximale d'un fetch de page (ms). */
  fetchTimeoutMs: Number(process.env.TP_FETCH_TIMEOUT_MS || 15000),
  tokenTimeoutMs: 25000,

  /** Recherche dans les avis : bornes de scan. */
  reviewPerPage: 8,
  reviewMaxScanPages: Number(process.env.TP_SCAN_MAX_PAGES || 40),
  reviewScanBudgetMs: Number(process.env.TP_SCAN_BUDGET_MS || 20000),
  reviewMaxHits: 240,
  reviewSnippets: 3,
  reviewStateTtlMs: 10 * 60 * 1000,
  reviewStateMax: 60,
  reviewCacheTtlMs: 15 * 60 * 1000,
  reviewCacheMax: 800,
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
