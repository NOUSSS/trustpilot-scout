import { toCsv } from './csv.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#filters'),
  q: $('#q'),
  category: $('#category'),
  categoryInput: $('#category-input'),
  categoryList: $('#category-list'),
  advanced: $('#advanced'),
  advancedCount: $('#advanced-count'),
  term: $('#term'),
  country: $('#country'),
  city: $('#city'),
  stars: $('#stars'),
  reviews: $('#reviews'),
  rating: $('#rating'),
  lang: $('#lang'),
  sort: $('#sort'),
  submit: $('#submit'),
  submitLabel: $('#submit span'),
  export: $('#export'),
  results: $('#results'),
  head: $('#results-head'),
  count: $('#count'),
  countLabel: $('#count-label'),
  meta: $('#meta'),
  hint: $('#hint'),
};

/** Paramètres d'API, chacun lié au champ du même nom. Tous se combinent. */
const FIELDS = ['q', 'category', 'term', 'country', 'city', 'stars', 'reviews', 'rating', 'lang', 'sort'];
/** Champs repliés sous « Options avancées ». */
const ADVANCED = ['country', 'city', 'stars', 'reviews', 'rating', 'lang', 'sort'];
/** Valeurs par défaut, omises de l'URL. */
const DEFAULTS = { lang: 'all', sort: 'relevance' };

const state = {
  page: 1,
  params: null,
  data: null,
  controller: null,
};

const O = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const option = (value, label) => {
  const opt = O('option', null, label);
  opt.value = value;
  return opt;
};

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Trustpilot entoure les correspondances de <em> : on les rend en <mark>. */
const highlighted = (s) =>
  escapeHtml(s).replace(/&lt;em&gt;/g, '<mark>').replace(/&lt;\/em&gt;/g, '</mark>');

const plain = (s) => String(s ?? '').replace(/<\/?em>/g, '');

/** Guillemets français, espaces insécables comprises. */
const quoted = (s) => `« ${s} »`;

const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });
const languageNames = new Intl.DisplayNames(['fr'], { type: 'language' });

/** Nom de pays lisible : Trustpilot donne tantôt « France », tantôt « FR ». */
const countryName = (value) => {
  if (!/^[A-Z]{2}$/.test(value ?? '')) return value ?? '';
  try {
    return regionNames.of(value);
  } catch {
    return value;
  }
};

const languageName = (code) => {
  if (!code) return '';
  try {
    const name = languageNames.of(code);
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code;
  }
};

const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? dateFormat.format(d) : '';
};

const nf = (n) => Number(n ?? 0).toLocaleString('fr-FR');

/* ---------- Options ---------- */
const categoryNames = new Map();
/** Secteurs à plat, dans l'ordre de Trustpilot : chaque secteur suivi de ses sous-secteurs. */
const categories = [];
const labels = { stars: new Map(), reviews: new Map(), rating: new Map(), sort: new Map() };

async function loadOptions() {
  try {
    const res = await fetch('/api/options');
    const data = await res.json();

    const fill = (el, list, key) => {
      for (const o of list) {
        el.append(option(o.value, o.label));
        labels[key]?.set(o.value, o.label);
      }
    };
    fill(els.stars, data.stars, 'stars');
    fill(els.reviews, data.reviews, 'reviews');
    fill(els.rating, data.reviewStars, 'rating');
    fill(els.sort, data.sorts, 'sort');

    for (const top of data.categories) {
      categoryNames.set(top.id, top.name);
      categories.push({ id: top.id, name: top.name, group: true, key: fold(top.name) });
      for (const sub of top.sub) {
        categoryNames.set(sub.id, sub.name);
        categories.push({ id: sub.id, name: sub.name, parent: top.name, key: fold(`${sub.name} ${top.name}`) });
      }
    }

    const countries = data.countries
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    for (const c of countries) els.country.append(option(c.code, c.name));

    for (const code of data.reviewLanguages) {
      els.lang.append(option(code, code === 'all' ? 'Toutes' : languageName(code)));
    }
  } catch {
    /* les selects restent vides, la recherche par mot-clé fonctionne quand même */
  }
}

/* ---------- Combinaison des paramètres ---------- */
/** Même règle que le serveur (`domainFrom`) : une saisie sans espace avec une extension. */
function looksLikeDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw || /\s/.test(raw)) return false;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
    return /^[a-z0-9.-]+\.[a-z]{2,}\.?$/i.test(host) || /^xn--/.test(host.split('.').pop());
  } catch {
    return false;
  }
}

/**
 * Type de résultat, comme le serveur : un domaine montre ses avis ; un filtre
 * d'avis fouille les avis des entreprises ; sinon, la liste des entreprises.
 */
function kindOf(p) {
  if (looksLikeDomain(p.q)) return 'company';
  // Comme le serveur : sans entreprise, secteur ni texte, il n'y a rien à fouiller.
  if (!p.q && !p.category && !p.term) return null;
  if (p.term || p.rating || (p.lang && p.lang !== 'all')) return 'scan';
  return 'list';
}

/** Grise les champs sans effet sur la combinaison en cours, plutôt que de les cacher. */
function updateFields(p) {
  const kind = kindOf(p);
  const company = kind === 'company';
  for (const el of [els.categoryInput, els.country, els.city, els.stars, els.reviews]) el.disabled = company;
  if (company) closeCombo();
  // Trustpilot ne trie que les secteurs et les avis d'une entreprise.
  els.sort.disabled = !company && !p.category;
  for (const opt of els.sort.options) opt.disabled = company && opt.value === 'reviews';
  els.hint.textContent = describe(p);
  const active = ADVANCED.filter((name) => p[name] && p[name] !== (DEFAULTS[name] ?? '')).length;
  els.advancedCount.textContent = active ? String(active) : '';
}

/** La combinaison en une phrase : ce que la recherche va réellement faire. */
function describe(p) {
  const kind = kindOf(p);
  if (!kind) return 'Renseigne une entreprise, un secteur ou un texte à chercher dans les avis, puis combine les filtres.';

  const reviewParts = [];
  if (p.term) reviewParts.push(`contenant ${quoted(p.term)}`);
  if (p.rating) reviewParts.push(`notés ${labels.rating.get(p.rating)?.toLowerCase() ?? p.rating}`);
  if (p.lang && p.lang !== 'all') reviewParts.push(`en ${languageName(p.lang).toLowerCase()}`);
  const sortLabel = labels.sort.get(p.sort)?.toLowerCase();

  if (kind === 'company') {
    const sorted = p.term && p.sort === 'relevance' ? 'par pertinence' : 'du plus récent au plus ancien';
    return [`Avis de ${p.q.trim()}`, ...reviewParts].join(', ') + `, ${sorted}.`;
  }

  const parts = ['Entreprises'];
  if (p.category) parts.push(`du secteur ${categoryNames.get(p.category) ?? p.category}`);
  if (p.q) parts.push(p.category ? `dont le nom contient ${quoted(p.q)}` : `trouvées pour ${quoted(p.q)}`);
  else if (!p.category) parts.push(`trouvées pour ${quoted(p.term)}`);
  const place = [p.city, countryName(p.country)].filter(Boolean).join(', ');
  let sentence = parts.join(' ') + (place ? ` (${place})` : '');
  const extra = [];
  if (p.stars) extra.push(`notées ${labels.stars.get(p.stars)?.toLowerCase() ?? p.stars}`);
  if (p.reviews) extra.push(labels.reviews.get(p.reviews) ?? `${p.reviews} avis et +`);
  if (extra.length) sentence += `, ${extra.join(', ')}`;
  if (kind === 'scan') sentence += `, qui ont des avis ${reviewParts.join(', ')}`;
  if (p.category && sortLabel) sentence += `, triées par ${sortLabel}`;
  sentence += '.';
  if (kind === 'scan') sentence += ' Les avis de chaque entreprise sont interrogés un à un : compte quelques secondes.';
  return sentence;
}

/* ---------- Rendu ---------- */
const ICONS = {
  star:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/></svg>',
  search:
    '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg>',
  inbox:
    '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/></svg>',
  alert:
    '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
};

/** Teinte du tag de note, sur la palette du design system. */
const scoreTone = (s) =>
  s >= 4 ? 'tag-success' : s >= 3 ? 'tag-warning' : s >= 2 ? 'tag-orange' : 'tag-danger';

/** Bloc d'état centré, comme l'état vide « Inbox » du design system. */
function stateBox(icon, title, text, cls = '') {
  const box = O('div', `state ${cls}`.trim());
  const ic = O('span', 'state-icon');
  ic.innerHTML = ICONS[icon];
  box.append(ic, O('strong', null, title), O('p', null, text));
  return box;
}

const external = (a, href) => {
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};

/** URL de la recherche courante avec d'autres valeurs (paramètres vides ou par défaut omis). */
function searchUrl(params, page = 1) {
  const url = new URL(location.href);
  url.search = '';
  for (const name of FIELDS) {
    const value = params?.[name];
    if (value && value !== DEFAULTS[name]) url.searchParams.set(name, value);
  }
  if (page > 1) url.searchParams.set('page', String(page));
  return url;
}

/**
 * Lien interne vers les avis d'une entreprise : mêmes filtres, entreprise
 * remplacée par son domaine. Un clic simple reste dans la page (historique
 * conservé), un clic molette ouvre un onglet.
 */
function companyLink(a, domain) {
  a.href = searchUrl({ ...state.params, q: domain }).href;
  a.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(null, '', a.href);
    loadFromUrl();
  });
  return a;
}

function avatarFor(item) {
  const avatar = O('span', 'avatar');
  avatar.textContent = (item.name || item.domain || '?').trim().charAt(0).toUpperCase();
  if (item.id) {
    // L'image doit être dans la page dès le départ : une image « lazy » détachée n'est jamais chargée.
    const img = new Image();
    img.loading = 'lazy';
    img.alt = '';
    img.onload = () => avatar.classList.add('has-logo');
    img.onerror = () => img.remove();
    img.src = `https://consumersiteimages.trustpilot.net/business-units/${item.id}-198x149-1x.avif`;
    avatar.append(img);
  }
  return avatar;
}

function scoreTag(value, text) {
  const score = O('span', `tag score ${scoreTone(value)}`);
  score.innerHTML = ICONS.star;
  score.append(text);
  return score;
}

function ratingLine(item) {
  const rating = O('div', 'rating');
  const line = O('div', 'rating-line');
  const score = scoreTag(item.stars, item.stars.toFixed(1).replace('.', ','));
  const reviews = O('span', 'reviews');
  reviews.append(O('b', null, nf(item.reviews)), ' avis');
  line.append(score, reviews);

  // Barre de progression, comme le bloc « Benefits » : note sur 5.
  const meter = O('div', 'meter');
  const fill = O('span');
  fill.style.width = `${(Math.max(0, Math.min(5, item.stars)) / 5) * 100}%`;
  meter.append(fill);

  rating.append(line, meter);
  return rating;
}

function tagsFor(item) {
  const tags = O('div', 'tags');
  if (item.country) tags.append(O('span', 'tag', countryName(item.country)));
  for (const c of (item.categories || []).slice(0, 2)) tags.append(O('span', 'tag', c));
  return tags;
}

/** Carte d'entreprise : ouvre ses avis, avec les filtres d'avis en cours. */
function businessCard(item) {
  const a = companyLink(O('a', 'card'), item.domain);
  const top = O('div', 'card-top');
  const title = O('span', 'card-title');
  title.append(O('strong', null, item.name || item.domain), O('small', null, item.domain));
  top.append(avatarFor(item), title);
  a.append(top, ratingLine(item), tagsFor(item));
  return a;
}

function scanCard(item) {
  const card = O('article', 'card');

  const top = O('div', 'card-top');
  const title = O('span', 'card-title');
  const strong = O('strong');
  strong.append(companyLink(O('a', null, item.name || item.domain), item.domain));
  title.append(strong, O('small', null, item.domain));

  const badge = O('span', 'tag tag-primary matches', `${nf(item.matchCount)} avis`);
  badge.title = 'Nombre d’avis qui correspondent';
  top.append(avatarFor(item), title, badge);
  card.append(top);

  const list = O('div', 'snippets');
  for (const snip of item.snippets.slice(0, 3)) {
    const box = O('div', 'snippet');
    const p = O('p');
    p.innerHTML = highlighted(snip.title ? `${snip.title} — ${snip.text}` : snip.text);
    const meta = O('small');
    meta.append(
      `${snip.rating}/5 · ${snip.author}${snip.country ? ` (${snip.country})` : ''} · `,
      external(O('a', null, 'voir l’avis'), snip.url)
    );
    box.append(p, meta);
    list.append(box);
  }
  card.append(list);
  card.append(tagsFor(item));
  return card;
}

/** Fiche de l'entreprise en tête de ses avis. */
function companyCard(business) {
  const card = O('article', 'card company');

  const top = O('div', 'card-top');
  const title = O('span', 'card-title');
  const strong = O('strong');
  strong.append(external(O('a', null, business.name || business.domain), business.url));
  title.append(strong, O('small', null, business.domain));
  top.append(avatarFor(business), title);

  const main = O('div', 'company-main');
  main.append(top, ratingLine(business), tagsFor(business));
  card.append(main);
  return card;
}

function reviewCard(review) {
  const card = O('article', 'card review');

  const top = O('div', 'review-top');
  top.append(scoreTag(review.rating, String(review.rating)));
  const who = O('small', 'review-who');
  who.textContent = [review.author, countryName(review.country)].filter(Boolean).join(' · ');
  top.append(who);
  if (review.date !== undefined) top.append(O('small', 'review-date', formatDate(review.date) || review.date));
  card.append(top);

  if (review.title) {
    const title = O('strong', 'review-title');
    title.innerHTML = highlighted(review.title);
    card.append(title);
  }
  const text = O('p', 'review-text');
  text.innerHTML = highlighted(review.text);
  card.append(text);

  const meta = O('small', 'review-meta');
  const parts = [languageName(review.language), review.replied ? 'réponse de l’entreprise' : ''].filter(Boolean);
  if (parts.length) meta.append(`${parts.join(' · ')} · `);
  meta.append(external(O('a', null, 'voir l’avis'), review.url));
  card.append(meta);
  return card;
}

/** Squelettes : les vraies cartes, construites par les mêmes fonctions, avec
 *  des textes inconnus en espaces insécables masqués par la CSS. */
const NB = ' ';
const SKELETON_ITEM = {
  name: NB, domain: NB, stars: 0, reviews: 0, url: '#',
  country: NB, categories: [NB, NB],
  matchCount: 0,
  snippets: [1, 2, 3].map(() => ({ text: `${NB}\n${NB}\n${NB}`, rating: NB, author: NB, url: '#' })),
};
// Fouille des avis : le badge réduit la largeur, chaque rangée a au moins un nom sur deux lignes.
const SKELETON_SCAN_ITEM = { ...SKELETON_ITEM, name: `${NB}\n${NB}` };
// Fiche entreprise : pays et un secteur, sur une seule rangée de tags.
const SKELETON_COMPANY = { ...SKELETON_ITEM, categories: [NB] };
// Avis : titre sur une ligne, texte coupé à 4 lignes (le cas courant, avis longs).
const SKELETON_REVIEW = {
  rating: 0, author: NB, country: '', date: NB, title: NB,
  text: [NB, NB, NB, NB].join('\n'), language: '', replied: false, url: '#',
};

/** Textes des squelettes : une barre par ligne, posée sous un texte masqué. */
const SKELETON_TEXTS = [
  '.card-title strong', '.card-title small', '.reviews',
  '.snippet p', '.snippet small',
  '.review-who', '.review-date', '.review-title', '.review-text', '.review-meta',
].join(',');

function skeletonLines(el) {
  const lines = el.textContent.split('\n');
  if (lines.length === 1) {
    // Une seule ligne : on garde le contenu (un texte connu garde sa largeur).
    const line = O('span', 'sk-line');
    line.append(...el.childNodes);
    el.append(line);
  } else {
    el.replaceChildren(...lines.map((text) => O('span', 'sk-line', text)));
  }
}

function skeletonize(card) {
  card.querySelectorAll(SKELETON_TEXTS).forEach(skeletonLines);
  card.classList.add('is-skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.removeAttribute('href');
  return card;
}

function skeletons(kind, n = 6) {
  const grid = O('div', 'grid');
  grid.setAttribute('aria-busy', 'true');
  if (kind === 'company') {
    // Même entreprise qu'à l'affichage précédent (page, filtre) : sa fiche est connue.
    const known =
      state.data?.kind === 'company' && state.data.params?.q === state.params?.q ? state.data : null;
    const company = known ? companyCard(known.business) : skeletonize(companyCard(SKELETON_COMPANY));
    grid.classList.add('reviews-grid');
    for (let i = 0; i < n; i++) grid.append(skeletonize(reviewCard(SKELETON_REVIEW)));
    els.results.replaceChildren(company, grid);
    return;
  }
  for (let i = 0; i < n; i++) {
    const card = kind === 'scan' ? scanCard(SKELETON_SCAN_ITEM) : businessCard(SKELETON_ITEM);
    grid.append(skeletonize(card));
  }
  els.results.replaceChildren(grid);
}

function pagerButton(label, page, opts = {}) {
  const b = O('button', null, label);
  b.type = 'button';
  if (opts.current) b.setAttribute('aria-current', 'page');
  if (opts.disabled) b.disabled = true;
  b.addEventListener('click', () => go(page));
  return b;
}

function renderPager(p) {
  const pager = O('nav', 'pager');
  pager.setAttribute('aria-label', 'Pagination');
  pager.append(pagerButton('‹', p.page - 1, { disabled: !p.hasPrevious }));

  if (p.totalPages) {
    const pages = new Set([1, p.totalPages]);
    for (let i = p.page - 2; i <= p.page + 2; i++) if (i >= 1 && i <= p.totalPages) pages.add(i);
    let prev = 0;
    for (const n of [...pages].filter((x) => x >= 1).sort((a, b) => a - b)) {
      if (n - prev > 1) pager.append(O('span', 'gap', '…'));
      pager.append(pagerButton(String(n), n, { current: n === p.page, disabled: n === p.page }));
      prev = n;
    }
  } else {
    // Collecte : seules les pages déjà trouvées, plus la suivante si le scan peut continuer.
    const last = Math.ceil(p.found / p.perPage) + (p.hasNext && p.found <= p.page * p.perPage ? 1 : 0);
    for (let i = Math.max(1, p.page - 2); i <= Math.min(p.page + 2, Math.max(last, p.page)); i++) {
      pager.append(pagerButton(String(i), i, { current: i === p.page, disabled: i === p.page }));
    }
  }

  pager.append(pagerButton('›', p.page + 1, { disabled: !p.hasNext }));

  if (p.totalPages > 1) {
    const jump = O('div', 'pager-jump');
    const input = O('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(p.totalPages);
    input.placeholder = `/${p.totalPages}`;
    input.setAttribute('aria-label', 'Aller à la page');
    const goBtn = O('button', null, 'Aller');
    goBtn.type = 'button';
    const jumpTo = () => {
      const n = Number.parseInt(input.value, 10);
      if (n >= 1) go(Math.min(n, p.totalPages));
    };
    goBtn.addEventListener('click', jumpTo);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpTo(); } });
    jump.append(input, goBtn);
    pager.append(jump);
  }

  return pager;
}

const cacheLabel = (c) => (c === 'hit' ? 'cache' : c === 'shared' ? 'requête partagée' : 'réseau');

/** Méta d'une collecte : avancement du parcours de la source. */
function scanMeta(p) {
  const total = p.totalBusinesses != null ? nf(p.totalBusinesses) : '?';
  return `page ${p.page} · ${nf(p.scannedBusinesses)} entreprises parcourues / ${total}` +
    (p.partial ? ' · parcours interrompu' : '');
}

function renderList(data) {
  const p = data.pagination;
  els.meta.textContent = data.collected
    ? scanMeta(p)
    : `page ${p.page} / ${Math.max(p.totalPages, 1)} · ${cacheLabel(data.cache)}`;

  if (!data.items.length) {
    els.results.replaceChildren(
      stateBox(
        'inbox',
        'Aucun résultat',
        data.params.category
          ? 'Change de pays, retire la ville ou le nom, ou baisse la note et le nombre d’avis exigés.'
          : 'Élargis la recherche, baisse la note minimale ou réduis le nombre d’avis exigé.'
      )
    );
    return;
  }
  const grid = O('div', 'grid');
  for (const item of data.items) grid.append(businessCard(item));
  els.results.replaceChildren(grid, renderPager(p));
}

function renderCompany(data) {
  const p = data.pagination;
  els.meta.textContent = `page ${p.page} / ${Math.max(p.totalPages, 1)} · ${cacheLabel(data.cache)}`;

  const company = companyCard(data.business);
  if (!data.items.length) {
    const filtered = data.params.term || data.params.rating || data.params.language !== 'all';
    els.results.replaceChildren(
      company,
      stateBox(
        'inbox',
        'Aucun avis',
        filtered
          ? 'Aucun avis ne correspond à ces filtres : essaie un autre mot, une autre note ou toutes les langues.'
          : 'Cette entreprise n’a pas encore d’avis publié.'
      )
    );
    return;
  }
  const grid = O('div', 'grid reviews-grid');
  for (const review of data.items) grid.append(reviewCard(review));
  els.results.replaceChildren(company, grid, renderPager(p));
}

function renderScan(data) {
  const p = data.pagination;
  els.meta.textContent = scanMeta(p);

  if (!data.items.length) {
    const box = stateBox(
      'inbox',
      p.hasNext ? 'Recherche en cours…' : 'Aucun avis ne correspond',
      p.hasNext
        ? 'Le parcours continue sur les entreprises suivantes. Relance la même page dans quelques secondes.'
        : 'Essaie un texte plus large, une autre note d’avis, ou retire des filtres d’entreprise.'
    );
    if (p.hasNext) {
      const next = O('button', 'btn', 'Continuer');
      next.type = 'button';
      next.addEventListener('click', () => go(p.page));
      box.append(next);
    }
    els.results.replaceChildren(box);
    return;
  }

  const grid = O('div', 'grid');
  for (const item of data.items) grid.append(scanCard(item));
  els.results.replaceChildren(grid, renderPager(p));
}

const COUNT_LABELS = {
  list: 'entreprise(s) trouvée(s)',
  scan: 'entreprise(s) avec avis correspondants',
  company: 'avis',
};

function render(data) {
  state.data = data;
  els.head.hidden = false;
  els.export.disabled = data.items.length === 0;
  els.countLabel.textContent = COUNT_LABELS[data.kind];
  els.count.textContent = nf(data.collected ? data.pagination.found : data.pagination.totalResults);

  if (data.kind === 'scan') renderScan(data);
  else if (data.kind === 'company') renderCompany(data);
  else renderList(data);

  // Collecte interrompue par le budget : on le dit sous les résultats.
  if (data.collected && data.items.length && data.pagination.partial) {
    const line = O('div', 'tag tag-warning scanline');
    line.append(O('span', 'dot'), O('span', null, 'Parcours interrompu par le budget : relance pour aller plus loin.'));
    els.results.append(line);
  }
}

function idleState() {
  els.results.replaceChildren(
    stateBox(
      'search',
      'Commence par une recherche',
      'Une entreprise, un secteur, un texte d’avis : remplis ce que tu veux, tous les filtres se combinent.'
    )
  );
}

function errorState(message) {
  els.head.hidden = true;
  els.export.disabled = true;
  const box = stateBox('alert', 'Ça n’a pas fonctionné', message, 'error');
  const retry = O('button', 'btn', 'Réessayer');
  retry.type = 'button';
  retry.addEventListener('click', () => go(state.page));
  box.append(retry);
  els.results.replaceChildren(box);
}

/* ---------- Requêtes ---------- */
function readForm() {
  const params = {};
  for (const name of FIELDS) params[name] = els[name].value.trim();
  return params;
}

/** Remplit tous les champs depuis l'URL (valeur absente : défaut). */
function fillForm(search) {
  for (const name of FIELDS) {
    const el = els[name];
    const value = search.get(name) ?? DEFAULTS[name] ?? '';
    el.value = value;
    // Valeur absente d'une liste : on garde le défaut plutôt qu'un select vide.
    if (el.value !== value) el.value = DEFAULTS[name] ?? '';
  }
  // Secteur inconnu : on l'oublie plutôt que d'envoyer un identifiant invalide.
  if (!categoryNames.has(els.category.value)) els.category.value = '';
  els.categoryInput.value = categoryNames.get(els.category.value) ?? '';
  // Un filtre avancé actif depuis l'URL reste visible.
  if (ADVANCED.some((name) => els[name].value !== (DEFAULTS[name] ?? ''))) els.advanced.open = true;
}

function syncUrl() {
  history.replaceState(null, '', searchUrl(state.params, state.page));
}

function resetSubmit(controller) {
  if (state.controller !== controller) return;
  els.submit.disabled = false;
  els.submitLabel.textContent = 'Chercher';
}

/**
 * Serveur occupé (les parcours précédents ne sont pas encore arrêtés) : la page
 * patiente et réessaie au lieu d'afficher une erreur.
 */
const BUSY_WAIT_MS = 2000;
const BUSY_MAX_WAITS = 12;
/** Au-delà de ce délai annoncé par le serveur, c'est une vraie limite : on l'affiche. */
const BUSY_MAX_RETRY_AFTER_S = 5;

async function go(page = 1, depth = 0, waits = 0) {
  const params = state.params ?? readForm();
  state.params = params;
  updateFields(params);
  const kind = kindOf(params);

  if (!kind) {
    state.controller?.abort();
    els.head.hidden = true;
    els.export.disabled = true;
    state.page = 1;
    syncUrl();
    idleState();
    els.q.focus();
    return;
  }

  state.page = page;
  syncUrl();

  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  els.submit.disabled = true;
  els.submitLabel.textContent = kind === 'scan' ? 'Fouille…' : 'Recherche…';
  // L'en-tête reste en place pendant le chargement : la grille ne bouge pas à l'arrivée.
  els.head.hidden = false;
  els.count.textContent = '…';
  els.countLabel.textContent = COUNT_LABELS[kind];
  els.meta.textContent = NB;
  skeletons(kind);

  const qs = new URLSearchParams({ page: String(page) });
  for (const [name, value] of Object.entries(params)) if (value) qs.set(name, value);

  try {
    const res = await fetch('/api/find?' + qs, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get('Retry-After'));
    const busy =
      (res.status === 429 || res.status === 503) && retryAfter > 0 && retryAfter <= BUSY_MAX_RETRY_AFTER_S;
    if (busy && waits < BUSY_MAX_WAITS) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
      if (state.controller !== controller) return;
      return go(page, depth, waits + 1);
    }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    if (state.controller !== controller) return;
    state.page = data.params?.page ?? page;
    syncUrl();
    render(data);
    // Une collecte interrompue par le budget sans aucun résultat : on relance (borné).
    if (data.collected && data.pagination.partial && !data.items.length && depth < 3) {
      resetSubmit(controller);
      return go(page, depth + 1);
    }
    els.head.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err.name === 'AbortError' || state.controller !== controller) return;
    errorState(
      err instanceof TypeError ? 'Le serveur ne répond pas. Réessaie dans un instant.' : err.message
    );
  } finally {
    resetSubmit(controller);
  }
}

/** Lit la recherche dans l'URL et la lance (chargement, retour arrière, lien interne). */
function loadFromUrl() {
  const search = new URLSearchParams(location.search);
  fillForm(search);
  state.params = readForm();
  updateFields(state.params);
  if (kindOf(state.params)) {
    go(Math.max(1, Number.parseInt(search.get('page'), 10) || 1));
  } else {
    state.controller?.abort();
    els.head.hidden = true;
    els.export.disabled = true;
    idleState();
  }
}

/* ---------- Export ---------- */
function exportCsv() {
  const data = state.data;
  if (!data?.items.length) return;
  let rows;

  if (data.kind === 'company') {
    rows = [['date', 'note', 'auteur', 'pays', 'langue', 'titre', 'texte', 'reponse', 'url']];
    for (const r of data.items) {
      rows.push([
        r.date?.slice(0, 10), r.rating, r.author, r.country, r.language,
        plain(r.title), plain(r.text), r.replied ? 'oui' : 'non', r.url,
      ]);
    }
  } else if (data.kind === 'scan') {
    rows = [['nom', 'domaine', 'note', 'avis', 'correspondances', 'extraits', 'url']];
    for (const it of data.items) {
      rows.push([
        it.name, it.domain, it.stars, it.reviews, it.matchCount,
        it.snippets.map((s) => plain(s.text)).join(' | '),
        it.url,
      ]);
    }
  } else {
    rows = [['nom', 'domaine', 'note', 'avis', 'pays', 'ville', 'categories', 'url']];
    for (const it of data.items) {
      rows.push([it.name, it.domain, it.stars, it.reviews, countryName(it.country), it.city, it.categories.join(' | '), it.url]);
    }
  }

  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const p = data.params;
  const subject =
    data.kind === 'company' ? data.business?.domain ?? p.q
    : [p.q, p.category, p.term, p.country].filter(Boolean).join('-');
  const suffix = { company: '-avis', scan: '-fouille', list: '' }[data.kind];
  const slug = String(subject).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-').slice(0, 40);
  a.download = `trustpilot-${slug}${suffix}-p${state.page}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ---------- Secteur : liste filtrée à la frappe ---------- */
/** Minuscules sans accents, pour comparer « energie » et « Énergie ». */
const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const combo = { matches: [], active: -1 };

function closeCombo() {
  els.categoryList.hidden = true;
  els.categoryInput.setAttribute('aria-expanded', 'false');
  els.categoryInput.removeAttribute('aria-activedescendant');
  combo.active = -1;
}

/** Nom avec la partie tapée en gras (comparée sans accents, même longueur une fois repliée). */
function markMatch(name, word) {
  const at = word ? fold(name).indexOf(word) : -1;
  if (at < 0 || fold(name).length !== name.length) return document.createTextNode(name);
  const frag = document.createDocumentFragment();
  frag.append(name.slice(0, at), O('mark', null, name.slice(at, at + word.length)), name.slice(at + word.length));
  return frag;
}

function renderCombo(text) {
  const words = fold(text).trim().split(/\s+/).filter(Boolean);
  combo.matches = words.length
    ? categories.filter((c) => words.every((w) => c.key.includes(w))).slice(0, 80)
    : [{ id: '', name: 'Tous les secteurs', group: true }, ...categories];

  const items = combo.matches.map((c, i) => {
    const li = O('li', c.group ? 'group' : 'sub');
    li.id = `category-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(c.id === els.category.value));
    li.append(markMatch(c.name, words[0] ?? ''));
    // Un sous-secteur trouvé hors de son groupe rappelle son parent.
    if (words.length && c.parent) li.append(O('span', 'combo-parent', ` · ${c.parent}`));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickCategory(c);
    });
    return li;
  });
  if (!items.length) items.push(O('li', 'empty', 'Aucun secteur'));
  els.categoryList.replaceChildren(...items);
  els.categoryList.hidden = false;
  els.categoryInput.setAttribute('aria-expanded', 'true');
  highlight(words.length ? (combo.matches.length ? 0 : -1) : combo.matches.findIndex((c) => c.id === els.category.value));
}

function highlight(i) {
  const lis = els.categoryList.querySelectorAll('[role="option"]');
  lis.forEach((li, j) => li.classList.toggle('active', j === i));
  combo.active = i;
  if (i >= 0 && lis[i]) {
    els.categoryInput.setAttribute('aria-activedescendant', lis[i].id);
    lis[i].scrollIntoView({ block: 'nearest' });
  } else {
    els.categoryInput.removeAttribute('aria-activedescendant');
  }
}

function pickCategory(c) {
  els.category.value = c.id;
  els.categoryInput.value = c.id ? c.name : '';
  closeCombo();
  state.params = readForm();
  if (kindOf(state.params)) go(1);
  else updateFields(state.params);
}

/** Saisie abandonnée : le champ revient au secteur choisi. */
function restoreCategoryText() {
  els.categoryInput.value = categoryNames.get(els.category.value) ?? '';
}

function setupCombo() {
  const input = els.categoryInput;
  input.addEventListener('focus', () => {
    input.select();
    renderCombo('');
  });
  input.addEventListener('click', () => {
    if (els.categoryList.hidden) renderCombo('');
  });
  input.addEventListener('input', (e) => {
    // Le formulaire écoute aussi « input » : une saisie en cours n'est pas encore un secteur.
    e.stopPropagation();
    renderCombo(input.value);
  });
  input.addEventListener('keydown', (e) => {
    const n = combo.matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (els.categoryList.hidden) return renderCombo('');
      if (!n) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlight(combo.active < 0 ? (step > 0 ? 0 : n - 1) : (combo.active + step + n) % n);
    } else if (e.key === 'Enter' && !els.categoryList.hidden) {
      // Entrée choisit le secteur en surbrillance au lieu d'envoyer le formulaire.
      const c = combo.matches[combo.active];
      if (!c) return;
      e.preventDefault();
      pickCategory(c);
    } else if (e.key === 'Escape' && !els.categoryList.hidden) {
      e.preventDefault();
      restoreCategoryText();
      closeCombo();
    }
  });
  input.addEventListener('blur', () => {
    // Champ vidé puis quitté : retour à « Tous les secteurs ».
    if (!input.value.trim() && els.category.value) pickCategory({ id: '' });
    restoreCategoryText();
    closeCombo();
  });
}

/* ---------- Init ---------- */
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.params = readForm();
  go(1);
});

// La phrase et les champs grisés suivent la saisie.
els.form.addEventListener('input', () => updateFields(readForm()));

// Changer une liste relance directement la recherche.
for (const el of [els.country, els.stars, els.reviews, els.rating, els.lang, els.sort]) {
  el.addEventListener('change', () => {
    state.params = readForm();
    if (kindOf(state.params)) go(1);
    else updateFields(state.params);
  });
}

els.export.addEventListener('click', exportCsv);
setupCombo();
window.addEventListener('popstate', loadFromUrl);

await loadOptions();
loadFromUrl();

