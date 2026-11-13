# Trustpilot Scout

Serveur Express qui lit les pages publiques de Trustpilot à travers un
navigateur headless (`puppeteer-core`), et interface statique dans `public/`.
Modules ES, pas d'étape de build, pas de TypeScript.

## Commandes

- `npm ci`, puis `npm start` : serveur sur http://127.0.0.1:8787.
  `npm run dev` le relance à chaque modification.
- `npm test` : tests unitaires (`node --test`), sans réseau ni navigateur.
- `node --check <fichier>` : contrôle de syntaxe.

## Repères

- `src/server.js` démarre le serveur dès l'import : ne jamais l'importer
  dans un test. La logique testable vit dans les autres modules.
- `src/trustpilot.js` : validation des paramètres et lecture des pages.
  `src/browser.js` : session du navigateur et jeton WAF. `src/cache.js` :
  cache et file d'attente. `src/reviews.js` : collecteur des parcours.
- Une recherche réelle envoie des requêtes à Trustpilot. Les tests utilisent
  des pages synthétiques ; garder les essais réels peu nombreux.
- `/api/_debug/expire` n'existe que hors production (`NODE_ENV`).
- Fichiers en CRLF sous Windows (conversion de git), LF dans le dépôt.

## Conventions

- Français partout : commentaires, libellés, messages de commit. Apostrophe
  typographique (’) dans les textes affichés à l'utilisateur.
- 2 espaces, guillemets simples, points-virgules.
- Pas de nouvelle dépendance sans nécessité : les petits utilitaires sont
  écrits à la main (`src/cache.js`).
- Commits de la forme « Sujet : détail », sans co-auteur ni mention d'outil.
- Un push sur `main` redéploie la production : ne pas pousser sans accord.
