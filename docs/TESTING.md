# Tests

Quatre niveaux, du plus rapide au plus réaliste. Les compteurs sont ceux de la dernière exécution complète avant livraison ;
la commande fait foi, pas ce document.

| Niveau                    | Outil                                   | Base de données                | Commande                                                            | Ordre de grandeur                     |
| ------------------------- | --------------------------------------- | ------------------------------ | ------------------------------------------------------------------- | ------------------------------------- |
| Partagé (schémas, règles) | Vitest                                  | non                            | `pnpm --filter @footfive/shared test`                               | ~107 tests                            |
| API — unitaires           | Vitest (projet `unit`)                  | non                            | `pnpm --filter @footfive/api exec vitest run --project unit`        | inclus ci-dessous                     |
| API — intégration         | Vitest (projet `integration`) + Fastify | **PostgreSQL réelle `*_test`** | `pnpm --filter @footfive/api exec vitest run --project integration` | ~870 tests API au total (40 fichiers) |
| Web                       | Vitest + jsdom + Testing Library        | non                            | `pnpm --filter @footfive/web test`                                  | ~31 tests                             |
| Bout en bout              | Playwright + axe-core                   | **PostgreSQL réelle `*_e2e`**  | `pnpm e2e`                                                          | ~51 tests                             |

`pnpm test` lance les trois premiers niveaux via Turborepo. Le bout en bout est séparé (il démarre l'API compilée, Vite et un
navigateur) : `pnpm build` d'abord, puis `pnpm e2e`.

## Pourquoi une vraie base PostgreSQL

Les garanties qui comptent (contrainte d'exclusion anti-double-réservation, `CHECK` de montants, verrous de ligne, index uniques
partiels, trigger d'audit) **n'existent que dans PostgreSQL**. Un test sur base simulée les contournerait. Les tests refusent de
démarrer si le nom de la base ne finit pas par `_test` (intégration) ou `_test`/`_e2e` (bout en bout) : impossible d'effacer la base
de développement par accident.

## Ce qui est couvert

- **Concurrence (obligatoire)** : N requêtes simultanées sur le même créneau → exactement une réservation, les autres reçoivent un
  conflit propre ; idem pour la dernière place d'une session solo et pour l'acceptation d'un adversaire. Le test de bout en bout
  rejoue le scénario avec deux vrais navigateurs.
- **Argent** : commission configurable (aucune valeur codée en dur), acompte séparé de la commission, arrondis, remboursements
  partiels et répétés, cohérence `total = base + frais + taxes`.
- **Webhooks** : signature invalide, horodatage trop ancien ou futur, rejeu, paiement tardif après expiration, ordre inversé.
- **Autorisation** : chaque rôle, refus 401/403, isolation entre complexes, accès aux ressources d'autrui.
- **Base de données** : contraintes testées directement en SQL, immutabilité de l'audit, session en UTC (régression d'un décalage
  d'une heure réellement trouvé).
- **Web** : composants clés, i18n (clés présentes dans les trois langues), formatage des dates en heure d'Alger.
- **Bout en bout** : parcours joueur complet (inscription → réservation → paiement simulé → confirmation), sessions solo,
  adversaires, espace gérant, administration, arabe en RTL, mobile 375 px (pas de défilement horizontal, cibles tactiles),
  **accessibilité WCAG AA** par axe-core (aucune violation grave ou critique sur les pages principales en français et en arabe).

## Préparer l'environnement

```bash
# Base de test d'intégration (créée par scripts/db/setup-local.sql ou par Docker)
pnpm --filter @footfive/api db:deploy      # avec DATABASE_URL pointant sur la base *_test

# Bout en bout : une base dédiée *_e2e, vidée et réalimentée à chaque lancement
export E2E_DATABASE_URL=postgresql://footfive:...@localhost:5432/footfive_e2e
pnpm build
cd e2e && pnpm exec playwright install chromium   # une fois
pnpm e2e
```

Sans Chromium téléchargé (réseau restreint), utilisez le navigateur installé : `PLAYWRIGHT_CHANNEL=msedge pnpm e2e` (ou `chrome`).
Rapport HTML : `pnpm --filter @footfive/e2e report`.

## Intégration continue

`.github/workflows/ci.yml` : un job **verify** (format, lint, types, build, tests, audit des dépendances de production) et un job
**e2e** (build, Chromium, Playwright), chacun avec son PostgreSQL de service. Le rapport Playwright est conservé en cas d'échec.
**Ces workflows n'ont pas encore été observés sur GitHub** : surveillez le premier passage.

## Limites

- Pas de tests de charge ni de performance ; le comportement sous forte concurrence est validé pour la **justesse** (jamais deux
  réservations), pas pour le débit.
- Le navigateur de test est Chromium/Edge : Safari et Firefox ne sont pas couverts.
- Les emails sont vérifiés via un transport en mémoire, pas via un vrai serveur SMTP.
- L'adaptateur de paiement réel n'existe pas, donc rien ne le teste ; le prestataire simulé suit le même contrat.
- Un échec isolé et non reproduit a été observé une fois sur les suites d'administration lors d'une exécution très chargée
  (probablement un délai d'initialisation) ; surveillez-le en CI.
