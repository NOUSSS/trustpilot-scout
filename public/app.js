const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#filters'),
  q: $('#q'),
  qLabel: $('#q-label'),
  category: $('#category'),
  term: $('#term'),
  country: $('#country'),
  stars: $('#stars'),
  reviews: $('#reviews'),
  location: $('#location'),
  locationLabel: $('#location-label'),
  sort: $('#sort'),
  rating: $('#rating'),
  lang: $('#lang'),
  rsort: $('#rsort'),
  submit: $('#submit'),
  submitLabel: $('#submit span'),
  export: $('#export'),
  results: $('#results'),
  head: $('#results-head'),
  count: $('#count'),
  countLabel: $('#count-label'),
  meta: $('#meta'),
  hint: $('#hint'),
  status: $('#status'),
  statusText: $('#status-text'),
};

/**
 * Chaque mode : point d'API, champs envoyés (nom d'API → élément) et textes.
 * Les champs absents d'un mode sont masqués (attribut data-modes du HTML).
 */
const MODES = {
  business: {
    endpoint: '/api/search',
    fields: { q: 'q', stars: 'stars', reviews: 'reviews', location: 'location' },
    required: 'q',
    qLabel: 'Recherche',
    placeholder: 'nom, domaine ou mot-clé (ex. vpn, boulangerie paris, fnac.com)',
    locationLabel: 'Localisation',
    locationPlaceholder: 'pays ou ville (ex. France)',
    hint: 'Trustpilot plafonne le filtre d’avis à <b>500+</b> et propose les notes minimales de <b>3, 4 et 4,5</b>. Pour un volume précis, affinez ensuite à l’export.',
    idle: 'Saisis un nom, un domaine ou un mot-clé (boutique, vpn, banque…), choisis une note minimale et un volume d’avis, puis lance la recherche.',
    busy: 'Recherche…',
    countLabel: 'entreprise(s) trouvée(s)',
  },
  category: {
    endpoint: '/api/category',
    fields: { category: 'category', country: 'country', stars: 'stars', location: 'location', sort: 'sort' },
    required: 'category',
    locationLabel: 'Ville',
    locationPlaceholder: 'facultatif (ex. Lyon)',
    hint: 'Les secteurs sont ceux de Trustpilot. Pas de tri par note : filtre avec la <b>note minimale</b>, puis trie par <b>nombre d’avis</b>.',
    idle: 'Choisis un secteur et un pays : les entreprises s’affichent dans l’ordre choisi.',
    busy: 'Recherche…',
    countLabel: 'entreprise(s) dans ce secteur',
  },
  company: {
    endpoint: '/api/company',
    fields: { q: 'q', term: 'term', rating: 'rating', lang: 'lang', sort: 'rsort' },
    required: 'q',
    qLabel: 'Entreprise',
    placeholder: 'nom, domaine ou URL (ex. fnac.com)',
    hint: 'Un nom renvoie l’entreprise la plus proche, avec les autres candidates. Trustpilot n’affiche que <b>10 pages</b> d’avis par recherche : filtre par note ou par mot pour aller plus loin.',
    idle: 'Saisis le nom, le domaine ou l’URL d’une entreprise, puis filtre ses avis par mot, note ou langue.',
    busy: 'Chargement…',
    countLabel: 'avis',
  },
  reviews: {
    endpoint: '/api/review-search',
    fields: { q: 'q', stars: 'stars', reviews: 'reviews', location: 'location' },
    required: 'q',
    qLabel: 'Recherche',
    placeholder: 'mot ou phrase cherchée dans le texte des avis (ex. remboursement, colis perdu)',
    locationLabel: 'Localisation',
    locationPlaceholder: 'pays ou ville (ex. France)',
    hint: 'Les entreprises sont parcourues une à une et leurs avis interrogés : <b>compte quelques secondes</b>. Les filtres de note et d’avis sont facultatifs.',
    idle: 'Saisis un mot ou une phrase : chaque entreprise trouvée est ensuite fouillée dans tous ses avis.',
    busy: 'Scan…',
    countLabel: 'entreprise(s) avec avis correspondants',
  },
};

const state = {
  mode: 'business',
  page: 1,
  params: null,
  data: null,
  controller: null,
};

const mode = () => MODES[state.mode];

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

async function loadOptions() {
  try {
    const res = await fetch('/api/options');
    const data = await res.json();

    for (const o of data.stars) els.stars.append(option(o.value, o.label));
    els.stars.value = '4.0';
    for (const o of data.reviews) els.reviews.append(option(o.value, o.label));
    els.reviews.value = '';

    for (const top of data.categories) {
      categoryNames.set(top.id, top.name);
      const group = O('optgroup');
      group.label = top.name;
      group.append(option(top.id, `${top.name} (tout le secteur)`));
      for (const sub of top.sub) {
        categoryNames.set(sub.id, sub.name);
        group.append(option(sub.id, sub.name));
      }
      els.category.append(group);
    }

    const countries = data.countries
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    for (const c of countries) els.country.append(option(c.code, c.name));
    els.country.value = 'FR';

    for (const o of data.categorySorts) els.sort.append(option(o.value, o.label));
    for (const o of data.reviewStars) els.rating.append(option(o.value, o.label));
    for (const code of data.reviewLanguages) {
      els.lang.append(option(code, code === 'all' ? 'Toutes les langues' : languageName(code)));
    }
    for (const o of data.reviewSorts) els.rsort.append(option(o.value, o.label));
  } catch {
    /* les selects restent vides, la recherche par mot-clé fonctionne quand même */
  }
}

async function health() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    els.status.className = 'tag status' + (data.authenticated ? ' on' : '');
    els.statusText.textContent = data.authenticated
      ? `Prêt · cache ${data.cache}`
      : data.browser
        ? 'Session en cours…'
        : 'Navigateur arrêté';
  } catch {
    els.status.className = 'tag status off';
    els.statusText.textContent = 'Serveur injoignable';
  }
}

/* ---------- Mode ---------- */
function setMode(name, { resetFilters = false } = {}) {
  state.mode = name;
  const m = mode();
  for (const btn of document.querySelectorAll('.mode')) {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === name));
  }
  for (const field of document.querySelectorAll('[data-modes]')) {
    field.hidden = !field.dataset.modes.split(' ').includes(name);
  }
  if (m.qLabel) els.qLabel.textContent = m.qLabel;
  if (m.placeholder) els.q.placeholder = m.placeholder;
  if (m.locationLabel) {
    els.locationLabel.textContent = m.locationLabel;
    els.location.placeholder = m.locationPlaceholder;
  }
  els.hint.innerHTML = m.hint;
  if (resetFilters && name === 'reviews') {
    els.stars.value = '';
    els.reviews.value = '';
  }
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

function avatarFor(item) {
  const avatar = O('span', 'avatar');
  avatar.textContent = (item.name || item.domain || '?').trim().charAt(0).toUpperCase();
  if (item.id) {
    const img = new Image();
    img.loading = 'lazy';
    img.alt = '';
    img.src = `https://consumersiteimages.trustpilot.net/business-units/${item.id}-198x149-1x.avif`;
    img.onload = () => { avatar.textContent = ''; avatar.append(img); };
    img.onerror = () => img.remove();
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

function businessCard(item) {
  const a = external(O('a', 'card'), item.url);
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
  strong.append(external(O('a', null, item.name || item.domain), item.url));
  title.append(strong, O('small', null, item.domain));

  const badge = O('span', 'tag tag-primary matches', `${nf(item.matchCount)} avis`);
  badge.title = 'Nombre d’avis contenant le terme';
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

/** Fiche de l'entreprise en tête des avis, avec les autres candidates. */
function companyCard(business, alternatives) {
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

  if (alternatives.length) {
    const alts = O('div', 'alts');
    alts.append(O('span', 'alts-label', 'Pas la bonne entreprise ?'));
    const list = O('div', 'alts-list');
    for (const alt of alternatives) {
      // Le domaine distingue les homonymes (« Darty » : darty.com, darty.be…).
      const b = O('button', 'tag alt', alt.domain || alt.name);
      b.type = 'button';
      if (alt.name) b.title = alt.name;
      b.addEventListener('click', () => {
        els.q.value = alt.domain;
        state.params = readForm();
        go(1);
      });
      list.append(b);
    }
    alts.append(list);
    card.append(alts);
  }
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
// Mode avis : le badge réduit la largeur, chaque rangée a au moins un nom sur deux lignes.
const SKELETON_SCAN_ITEM = { ...SKELETON_ITEM, name: `${NB}\n${NB}` };
// Fiche entreprise : pays et un secteur, sur une seule rangée de tags.
const SKELETON_COMPANY = { ...SKELETON_ITEM, categories: [NB] };
// Avis : titre sur une ligne, texte coupé à 4 lignes (le cas courant, avis longs).
const SKELETON_REVIEW = {
  rating: 0, author: NB, country: '', date: NB, title: NB,
  text: [NB, NB, NB, NB].join('\n'), language: '', replied: false, url: '#',
};

/** Une saisie sans espace avec un point est un domaine : pas de candidates. */
const looksLikeDomain = (s) => /^\S+\.\S{2,}$/.test(s.trim());

function skeletonize(card) {
  card.classList.add('is-skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.removeAttribute('href');
  return card;
}

function skeletons(n = 6) {
  const grid = O('div', 'grid');
  grid.setAttribute('aria-busy', 'true');
  if (state.mode === 'company') {
    // Même entreprise qu'à l'affichage précédent (page, filtre) : sa fiche est connue.
    const known = state.data?.business && state.data.params?.company === state.params?.q ? state.data : null;
    let company;
    if (known) {
      company = companyCard(known.business, known.alternatives ?? []);
    } else {
      const alts = looksLikeDomain(state.params?.q ?? '') ? [] : [1, 2, 3].map(() => ({ name: NB.repeat(12) }));
      company = skeletonize(companyCard(SKELETON_COMPANY, alts));
    }
    grid.classList.add('reviews-grid');
    for (let i = 0; i < n; i++) grid.append(skeletonize(reviewCard(SKELETON_REVIEW)));
    els.results.replaceChildren(company, grid);
    return;
  }
  for (let i = 0; i < n; i++) {
    const card = state.mode === 'reviews' ? scanCard(SKELETON_SCAN_ITEM) : businessCard(SKELETON_ITEM);
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
    for (let i = Math.max(1, p.page - 2); i <= p.page + 2; i++) {
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

function renderBusiness(data) {
  const p = data.pagination;
  const parts = [`page ${p.page} / ${p.totalPages}`];
  if (state.mode === 'category') {
    parts.push(categoryNames.get(data.params.category) ?? data.category?.name ?? data.params.category);
    parts.push(countryName(data.params.country));
  }
  parts.push(cacheLabel(data.cache));
  els.meta.textContent = parts.join(' · ');

  if (!data.items.length) {
    els.results.replaceChildren(
      stateBox(
        'inbox',
        'Aucun résultat',
        state.mode === 'category'
          ? 'Change de pays, retire la ville ou baisse la note minimale.'
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

  const company = companyCard(data.business, data.alternatives ?? []);
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
  const scanned = nf(p.scannedBusinesses);
  const total = p.totalBusinesses ? nf(p.totalBusinesses) : '?';
  els.meta.textContent = `page ${p.page} · ${scanned} entreprises scannées / ${total}` + (p.partial ? ' · scan interrompu' : '');

  if (!data.items.length) {
    const box = stateBox(
      'inbox',
      p.hasNext ? 'Recherche en cours…' : 'Aucun avis ne correspond',
      p.hasNext
        ? 'Le scan continue sur les entreprises suivantes. Relance la même page dans quelques secondes.'
        : 'Essaie un terme plus large, ou retire les filtres de note et de nombre d’avis.'
    );
    if (p.hasNext) {
      const next = O('button', 'btn', 'Continuer le scan');
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

  if (p.partial) {
    const line = O('div', 'tag tag-warning scanline');
    line.append(O('span', 'dot'), O('span', null, 'Scan interrompu par le budget : relance pour continuer plus loin.'));
    els.results.append(line);
  }
}

function render(data) {
  state.data = data;
  els.head.hidden = false;
  els.export.disabled = data.items.length === 0;
  els.countLabel.textContent = mode().countLabel;

  if (state.mode === 'reviews') {
    els.count.textContent = nf(data.pagination.found);
    renderScan(data);
  } else if (state.mode === 'company') {
    els.count.textContent = nf(data.pagination.totalResults);
    renderCompany(data);
  } else {
    els.count.textContent = nf(data.pagination.totalResults);
    renderBusiness(data);
  }
}

function idleState() {
  els.results.replaceChildren(stateBox('search', 'Commence par une recherche', mode().idle));
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
/** Valeurs des champs du mode courant, sous leur nom d'API. */
function readForm() {
  const params = {};
  for (const [name, key] of Object.entries(mode().fields)) {
    params[name] = els[key].value.trim();
  }
  return params;
}

/** Remplit les champs du mode courant depuis l'URL. */
function fillForm(search) {
  for (const [name, key] of Object.entries(mode().fields)) {
    const value = search.get(name);
    if (value == null) continue;
    const el = els[key];
    const previous = el.value;
    el.value = value;
    // Valeur absente d'une liste : on garde le défaut plutôt qu'un select vide.
    if (el.value !== value) el.value = previous;
  }
}

function syncUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (state.mode !== 'business') url.searchParams.set('mode', state.mode);
  for (const [name, value] of Object.entries(state.params ?? {})) {
    if (value) url.searchParams.set(name, value);
  }
  if (state.page > 1) url.searchParams.set('page', String(state.page));
  history.replaceState(null, '', url);
}

function resetSubmit(controller) {
  if (state.controller !== controller) return;
  els.submit.disabled = false;
  els.submitLabel.textContent = 'Chercher';
}

async function go(page = 1, depth = 0) {
  const params = state.params ?? readForm();
  state.params = params;
  const m = mode();

  if (!params[m.required]) {
    state.controller?.abort();
    els.head.hidden = true;
    els.export.disabled = true;
    state.page = 1;
    syncUrl();
    idleState();
    (state.mode === 'category' ? els.category : els.q).focus();
    return;
  }

  state.page = page;
  syncUrl();

  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  els.submit.disabled = true;
  els.submitLabel.textContent = m.busy;
  // L'en-tête reste en place pendant le chargement : la grille ne bouge pas à l'arrivée.
  els.head.hidden = false;
  els.count.textContent = '…';
  els.countLabel.textContent = m.countLabel;
  els.meta.textContent = NB;
  skeletons();

  const qs = new URLSearchParams({ page: String(page) });
  for (const [name, value] of Object.entries(params)) if (value) qs.set(name, value);

  try {
    const res = await fetch(m.endpoint + '?' + qs, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    if (state.controller !== controller) return;
    state.page = data.params?.page ?? page;
    syncUrl();
    render(data);
    // Un scan interrompu par le budget sans aucun résultat : on relance (borné).
    if (state.mode === 'reviews' && data.pagination.partial && !data.items.length && depth < 3) {
      resetSubmit(controller);
      return go(page, depth + 1);
    }
    els.head.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err.name === 'AbortError' || state.controller !== controller) return;
    errorState(
      err instanceof TypeError ? 'Le serveur local ne répond pas. Vérifie qu’il tourne toujours.' : err.message
    );
  } finally {
    resetSubmit(controller);
    if (state.controller === controller) health();
  }
}

/* ---------- Export ---------- */
function exportCsv() {
  const data = state.data;
  if (!data?.items.length) return;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let rows;

  if (state.mode === 'company') {
    rows = [['date', 'note', 'auteur', 'pays', 'langue', 'titre', 'texte', 'reponse', 'url']];
    for (const r of data.items) {
      rows.push([
        r.date?.slice(0, 10), r.rating, r.author, r.country, r.language,
        plain(r.title), plain(r.text), r.replied ? 'oui' : 'non', r.url,
      ]);
    }
  } else if (state.mode === 'reviews') {
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

  const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const p = state.params;
  const subject =
    state.mode === 'company' ? data.business?.domain ?? p.q
    : state.mode === 'category' ? `${p.category}-${p.country}`
    : p.q;
  const suffix = { company: '-avis', reviews: '-scan', category: '-secteur', business: '' }[state.mode];
  const slug = String(subject).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-').slice(0, 40);
  a.download = `trustpilot-${slug}${suffix}-p${state.page}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/* ---------- Init ---------- */
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  state.params = readForm();
  go(1);
});

// Changer un secteur, un pays ou un tri relance directement la recherche.
for (const el of [els.category, els.country, els.sort, els.rating, els.lang, els.rsort]) {
  el.addEventListener('change', () => {
    state.params = readForm();
    if (state.params[mode().required]) go(1);
  });
}

els.export.addEventListener('click', exportCsv);

for (const btn of document.querySelectorAll('.mode')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === state.mode) return;
    state.controller?.abort();
    setMode(btn.dataset.mode, { resetFilters: true });
    els.head.hidden = true;
    els.export.disabled = true;
    state.data = null;
    state.page = 1;
    state.params = readForm();
    syncUrl();
    if (state.params[mode().required]) go(1);
    else idleState();
  });
}

await loadOptions();

const initial = new URLSearchParams(location.search);
const initialMode = MODES[initial.get('mode')] ? initial.get('mode') : 'business';
setMode(initialMode, { resetFilters: initialMode === 'reviews' && !initial.get('stars') });
fillForm(initial);
state.params = readForm();

if (state.params[mode().required]) {
  go(Math.max(1, Number.parseInt(initial.get('page'), 10) || 1));
} else {
  idleState();
}

health();
setInterval(health, 30000);
