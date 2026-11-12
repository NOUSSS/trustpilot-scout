# Trustpilot Scout

Petit site local qui liste les entreprises référencées sur Trustpilot selon des
critères (mot-clé, secteur, note minimale, nombre d'avis, localisation) et
fouille leurs avis.
Pagination intégrée, cache et déduplication des requêtes.

Quatre modes :

- **Entreprises** — recherche par nom, domaine, URL ou mot-clé ; les filtres de
  note, d'avis et de localisation s'appliquent directement dans Trustpilot.
- **Par secteur** — les entreprises d'une catégorie Trustpilot (noms français),
  par pays et ville, avec note minimale et tri (pertinence, nombre d'avis,
  avis les plus récents).
- **Avis d'une entreprise** — les avis d'une entreprise donnée (nom, domaine ou
  URL), filtrables par mot, note, langue, triés par date ou pertinence.
- **Dans les avis** — le terme est cherché dans le *texte des avis* de chaque
  entreprise trouvée, sans condition de nombre d'avis ni de note. Les entreprises
  qui ont au moins un avis correspondant remontent, avec les extraits surlignés.

## Lancer

Double-clique sur `start.cmd`, ou :

```
npm install
npm start
```

Puis ouvre http://127.0.0.1:8787

Variables utiles :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `8787` | Port d'écoute |
| `HOST` | `127.0.0.1` | Interface d'écoute |
| `TP_BROWSER_PATH` | auto | Chemin vers `msedge.exe` / `chrome.exe` |
| `TP_CACHE_TTL_MS` | `600000` | Durée de vie du cache (10 min) |
| `TP_CONCURRENCY` | `3` | Requêtes simultanées vers Trustpilot |
| `TP_SCAN_MAX_PAGES` | `40` | Pages d'entreprises explorées max par recherche d'avis |
| `TP_SCAN_BUDGET_MS` | `20000` | Budget temps d'un scan d'avis |

## Comment ça marche

Trustpilot protège son site avec un challenge AWS WAF : une simple requête HTTP
répond `403`. Le serveur lance donc un navigateur headless (Edge ou Chrome déjà
installé), résout le challenge une fois, puis réutilise ce contexte pour toutes
les pages, récupérées via `fetch()` dans l'onglet — pas de rendu DOM complet,
donc quelques centaines de millisecondes par page au lieu de plusieurs secondes.

Les résultats sont lus dans le JSON `__NEXT_DATA__` embarqué par la page de
recherche, puis réduits aux champs utiles (nom, domaine, note, nombre d'avis,
pays, catégories). Le reste n'est jamais transmis au navigateur.

### Optimisations

- cache mémoire LRU avec TTL (clé = recherche normalisée + page) ;
- déduplication des requêtes en vol : deux clients qui demandent la même chose
  partagent un seul téléchargement ;
- limitation de concurrence (3) pour ne pas déclencher de blocage ;
- préchargement non bloquant de la page suivante ;
- clamps : pagination bornée à la dernière page réelle et à 1000 pages max,
  paramètres validés côté serveur, réponse vide immédiate sans mot-clé ;
- reprise automatique : jeton WAF expiré ou challenge raté → nouveau contexte
  isolé, nouvelle tentative, puis `503` explicite ;
- recherche dans les avis : état de scan partagé par critères (pas de re-scan
  inutile), cache des pages d'avis, budget temps et plafond de pages ;
- page reçue sans données (challenge servi en `200`) : nouvelle session et
  nouvelle tentative avant d'abandonner.

### Robustesse de la recherche

- La recherche sémantique de Trustpilot ramène parfois une poignée de résultats
  là où les mots-clés en trouvent des centaines (« boulangerie paris » : 5 contre
  1 095). Sous 50 résultats, les deux sont comparées et la plus fournie est
  retenue pour toute la pagination.
- Un domaine ou une URL collée (`https://www.fnac.com/…`) ouvre directement la
  fiche de l'entreprise ; les domaines accentués sont convertis en punycode.
- Avis d'une entreprise : un domaine est essayé tel quel puis avec `www.` ; un
  nom renvoie l'entreprise au nom identique (sinon la première trouvée) et
  jusqu'à 5 autres candidates.

### Recherche dans les avis

`/review/{domaine}?search=<terme>&languages=all&sort=relevance` renvoie les avis
contenant le terme (Trustpilot les entoure de `<em>`), avec un compteur total.

Le serveur explore les pages de résultats d'entreprises, interroge les avis de
chacune et n'ajoute que celles qui ont au moins une correspondance. Un « état de
scan » est mémorisé par critères : les requêtes suivantes (page 2, 3…) reprennent
le même état, ne téléchargent que ce qui manque et partagent le travail en cours.
Le scan est borné par un budget temps et un nombre de pages, avec reprise possible.

## API

`GET /api/search?q=shop&stars=4.0&reviews=100&location=France&page=2`

- `q` — mot-clé (obligatoire)
- `stars` — `3.0`, `4.0` ou `4.5` (note minimale)
- `reviews` — `25`, `50`, `100`, `250` ou `500` (avis minimum)
- `location` — pays ou ville en texte libre
- `page` — à partir de 1

`GET /api/category?category=money_insurance&country=FR&location=Lyon&stars=4.0&sort=reviews_count&page=1`

- `category` — identifiant de catégorie Trustpilot (liste dans `/api/options`)
- `country` — code pays (`FR` par défaut)
- `sort` — `most_relevant`, `reviews_count` ou `latest_review`

`GET /api/company?q=fnac.com&term=retard&rating=1&lang=fr&sort=relevance&page=1`

- `q` — nom, domaine ou URL de l'entreprise (obligatoire)
- `term`, `rating` (1 à 5), `lang` (`all`, `fr`, `en`…), `sort` (`recency` ou `relevance`)
- renvoie `business`, `alternatives` et les avis (`items`), 20 par page

`GET /api/review-search?q=remboursement&page=1` — mêmes filtres que `/api/search`,
tous facultatifs. Renvoie les entreprises avec `matchCount` et `snippets` (3 extraits max).

`GET /api/health` — état du navigateur, du jeton et du cache.

## Limites connues

- Trustpilot ne propose que les seuils 25/50/100/250/500 avis et 3/4/4,5
  étoiles : ce sont les seuls filtres serveur disponibles.
- La pagination Trustpilot s'arrête à 1000 pages (10 000 résultats).
- Recherche : pas de tri, l'ordre est celui de la pertinence Trustpilot. Les
  secteurs proposent trois tris, mais aucun par note.
- Avis d'une entreprise : Trustpilot ne sert que 10 pages (200 avis) par
  combinaison de filtres ; au-delà, il exige une connexion.
- Un délai d'~2 s au tout premier appel (démarrage du navigateur + challenge).
- Mode « dans les avis » : la couverture dépend du nombre d'entreprises ramenées
  par la recherche (plafonnée) ; chaque page utile coûte une requête par
  entreprise, d'où le cache et le budget. Un scan interrompu se reprend en
  relançant la page.

Usage raisonnable : les données sont publiques, mais il s'agit de scraping sur
des pages publiques ; garde le cache activé si tu automatises.
