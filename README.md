# Trustpilot Scout

Petit site qui liste les entreprises référencées sur Trustpilot selon des
critères (mot-clé, secteur, note minimale, nombre d'avis, localisation) et
fouille leurs avis.
Pagination intégrée, cache et déduplication des requêtes.

Un seul formulaire, dont tous les champs se combinent :

- **Entreprise** — nom, mot-clé, domaine ou URL ;
- **Secteur** — une catégorie Trustpilot (noms français) ;
- **Dans les avis** — mot ou phrase cherché dans le texte des avis ;
- filtres : pays, ville, note de l’entreprise, nombre d’avis, note de l’avis,
  langue des avis, tri.

Le type de résultat se déduit de la combinaison :

| Saisie | Résultat |
| --- | --- |
| un domaine ou une URL | les avis de cette entreprise, filtrés (texte, note, langue, tri) |
| un filtre d’avis (texte, note de l’avis, langue) | les entreprises de la source dont au moins un avis correspond, avec extraits |
| sinon | la liste des entreprises de la source |

La source est le secteur s’il est choisi (le nom saisi filtre alors ce
secteur), sinon la recherche par mot-clé (ou, à défaut, le texte des avis).
Exemple : secteur Banque & argent, France, 500 avis et +, avis 1 étoile
contenant « frais ». Une carte d’entreprise ouvre ses avis avec les mêmes
filtres ; le retour arrière revient à la liste.

## Lancer

Double-clique sur `start.cmd`, ou :

```
npm install
npm start
```

Puis ouvre http://127.0.0.1:8787

Tests (sans réseau ni navigateur) : `npm test`.

Avec Docker (Chromium inclus) :

```
docker build -t trustpilot-scout .
docker run -p 8787:8787 trustpilot-scout
```

Version en ligne : https://trustpilot.feitanx.com

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
| `TP_RATE_LIMIT_PER_MIN` | `120` | Requêtes `/api/find` par minute et par client (`0` : sans limite) |
| `TP_MAX_ACTIVE_SCANS` | `4` | Parcours simultanés au total (2 par client) |
| `TP_CLIENT_IP_HEADER` | aucun | En-tête qui porte l'adresse du client derrière un proxy de confiance (`cf-connecting-ip` derrière Cloudflare) |
| `TP_CACHE_MAX` | `600` | Nombre de pages gardées en cache |
| `TP_FETCH_TIMEOUT_MS` | `15000` | Durée maximale du téléchargement d'une page |
| `TP_LOCALE` | `en-US` | Langue annoncée par le navigateur headless |

Une valeur numérique invalide est ignorée : le défaut s'applique et le
serveur l'écrit dans son journal.

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
  paramètres validés côté serveur, refus immédiat en 400 sans entreprise,
  secteur ni texte d'avis ;
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
  nom donne la liste des entreprises, dont chaque carte ouvre les avis.

### Recherche dans les avis

`/review/{domaine}?search=<terme>&stars=<note>&languages=<langue>` renvoie les
avis filtrés (Trustpilot entoure le terme de `<em>`), avec un compteur total.

Le serveur explore les pages de la source (recherche ou secteur), interroge les avis de
chacune et n'ajoute que celles qui ont au moins une correspondance. Un « état de
scan » est mémorisé par critères : les requêtes suivantes (page 2, 3…) reprennent
le même état, ne téléchargent que ce qui manque et partagent le travail en cours.
Le scan est borné par un budget temps et un nombre de pages, avec reprise possible.

## API

`GET /api/find?category=banking_money&country=FR&reviews=500&term=frais&rating=1&page=1`

Tous les paramètres sont facultatifs, mais il faut au moins `q`, `category` ou `term`.

- `q` — entreprise : nom, mot-clé, domaine ou URL
- `category` — identifiant de secteur Trustpilot (liste dans `/api/options`)
- `country` — code pays (`FR`…), `city` — ville en texte libre
- `stars` — `3.0`, `4.0` ou `4.5` (note minimale de l’entreprise)
- `reviews` — `25`, `50`, `100`, `250` ou `500` (avis minimum)
- `term` — texte cherché dans les avis, `rating` — note de l’avis (1 à 5),
  `lang` — langue des avis (`all`, `fr`, `en`…)
- `sort` — `relevance`, `reviews` ou `recent` (secteur ; avis d’une entreprise
  hors `reviews`)
- `page` — à partir de 1

Renvoie `kind` (`company`, `scan` ou `list`), `items` et `pagination`. Une
collecte filtrée par le serveur (fouille des avis, ou nom et nombre d’avis
appliqués à un secteur) renvoie `collected: true` et une pagination sur ce qui
a été trouvé (`found`, `scannedBusinesses`, `totalBusinesses`, `partial`).

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
- Trustpilot ne filtre pas un secteur par nom ni par nombre d’avis : le
  serveur parcourt alors le secteur page par page, avec le même budget que la
  fouille des avis.
- Fouille des avis : la couverture dépend du nombre d'entreprises ramenées
  par la recherche (plafonnée) ; chaque page utile coûte une requête par
  entreprise, d'où le cache et le budget. Un scan interrompu se reprend en
  relançant la page.

Usage raisonnable : les données sont publiques, mais il s'agit de scraping sur
des pages publiques ; garde le cache activé si tu automatises.

Projet indépendant, sans lien avec Trustpilot.

## Licence

MIT, voir `LICENSE`.
