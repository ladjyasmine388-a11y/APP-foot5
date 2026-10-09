# Foot Five

Plateforme de réservation de terrains de **Foot Five** et de mise en relation :
réservez un créneau, complétez votre équipe, trouvez un adversaire.

> **Statut : les 11 étapes sont réalisées** — fondations, base de données, authentification, complexes et disponibilités, réservations,
> paiements, équipes / sessions / adversaires / matchs, notifications / emails / avis / images, administration, application web
> trilingue, tests de bout en bout et préparation au déploiement.
>
> **Pas encore prêt pour de vrais paiements** : l'adaptateur CIB / Edahabia n'est pas écrit, donc l'API refuse de démarrer en
> production (voir [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) et [docs/ROADMAP.md](docs/ROADMAP.md)). Tout le reste fonctionne avec le
> paiement simulé, en développement et en démonstration.

## Documentation

| Sujet                               | Document                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture d'ensemble             | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                                                                                                                                                                       |
| Déploiement, sauvegardes, 1er admin | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                                                                                                                                                                                                                           |
| Sécurité, liste avant production    | [docs/SECURITY.md](docs/SECURITY.md)                                                                                                                                                                                                                                               |
| Tests                               | [docs/TESTING.md](docs/TESTING.md)                                                                                                                                                                                                                                                 |
| Suite du projet                     | [docs/ROADMAP.md](docs/ROADMAP.md)                                                                                                                                                                                                                                                 |
| Domaines                            | [Données](docs/DATA-MODEL.md) · [Auth](docs/AUTH.md) · [Disponibilités](docs/AVAILABILITY.md) · [Réservations](docs/BOOKINGS.md) · [Paiements](docs/PAYMENTS.md) · [Social](docs/SOCIAL.md) · [Notifications](docs/NOTIFICATIONS.md) · [Admin](docs/ADMIN.md) · [Web](docs/WEB.md) |

API interactive en développement : <http://localhost:3000/api/docs>.

## Stack

| Couche          | Technologie                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ |
| Web             | React 19, Vite, TypeScript, Tailwind v4, TanStack Query, React Router, i18n AR/FR/EN + RTL |
| API             | NestJS 12 (Fastify), TypeScript, Zod, OpenAPI                                              |
| Base de données | PostgreSQL 16 + Prisma (étape 2)                                                           |
| Monorepo        | pnpm workspaces + Turborepo                                                                |
| Tests           | Vitest (unitaires, intégration sur vraie base) + Playwright / axe-core (bout en bout)      |
| Infra           | Docker Compose (dev : PostgreSQL, Mailpit, MinIO ; prod : PostgreSQL, API, nginx)          |

## Structure

```
apps/
  api/        API REST (NestJS) — même API pour le web et le futur mobile
  web/        Application web (React, PWA mobile-first)
packages/
  shared/     Enums, types et schémas Zod partagés
  config/     Configurations TypeScript / ESLint partagées
e2e/          Tests de bout en bout (Playwright)
docker/       Compose de développement, Dockerfiles et nginx de production
docs/         Documentation
```

## Démarrage rapide

Prérequis : Node.js ≥ 22, pnpm (`npm i -g pnpm`), PostgreSQL 16 (via Docker **ou** installé sur la machine).

```bash
pnpm install
cp .env.example .env        # puis adapter le port de la base (voir ci-dessous)
pnpm build                  # construit packages/shared (requis par api et web)
pnpm --filter @footfive/api db:migrate   # applique les migrations
pnpm --filter @footfive/api db:seed      # commission globale 1 % + paramètres par défaut
pnpm --filter @footfive/api db:seed:demo # (dev) 10 complexes, joueurs, équipes, parties… voir docs/WEB.md
pnpm --filter @footfive/api dev
pnpm --filter @footfive/web dev
```

### Base de données : deux options

**A. Docker** (recommandé) : `pnpm db:up` démarre PostgreSQL (port **5433**), Mailpit (8025) et MinIO (9001).
La base `footfive_test` et les extensions sont créées automatiquement.

**B. PostgreSQL installé sur la machine** (port **5432**) : exécutez une fois, en superutilisateur,

```powershell
& 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -U postgres -h localhost -f scripts/db/setup-local.sql
```

Le script crée le rôle `footfive` (non-superuser), les bases `footfive` et `footfive_test` en UTF-8 et
les extensions. Mettez ensuite le bon port dans `.env` (`DATABASE_URL`, `TEST_DATABASE_URL`).

### Comptes de démonstration

Après `db:seed:demo` (développement uniquement) : `admin@footfive.dz`, `gerant1@footfive.dz` … `gerant5@footfive.dz` (gérants de
complexes), `joueur01@footfive.dz` … `joueur20@footfive.dz` (joueurs). Le mot de passe commun est la constante `DEMO_PASSWORD`
de [`apps/api/prisma/seed-demo.ts`](apps/api/prisma/seed-demo.ts). Ces comptes n'existent **jamais** en production : le premier
administrateur s'y crée avec `db:create-admin` (voir [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

### Tests

```bash
pnpm test                                        # tout
pnpm --filter @footfive/api exec vitest run --project unit          # sans base de données
pnpm --filter @footfive/api exec vitest run --project integration   # vraie base *_test
pnpm build && pnpm e2e                           # bout en bout (navigateur réel, base *_e2e) — voir docs/TESTING.md
```

Les tests d'intégration utilisent **une vraie base PostgreSQL** (jamais celle de développement : ils refusent
de démarrer si le nom de la base ne finit pas par `_test`). C'est indispensable pour tester la concurrence
de réservation et les contraintes.

- API : <http://localhost:3000/api/v1/health>
- Web : <http://localhost:5173>
- Emails de dev (Mailpit) : <http://localhost:8025>

## Commandes

| Commande                                               | Rôle                                         |
| ------------------------------------------------------ | -------------------------------------------- |
| `pnpm build`                                           | Compile tous les paquets                     |
| `pnpm lint`                                            | ESLint                                       |
| `pnpm typecheck`                                       | Vérification des types                       |
| `pnpm test`                                            | Tests Vitest (partagé, API, web)             |
| `pnpm e2e`                                             | Tests de bout en bout Playwright             |
| `pnpm format` / `pnpm format:check`                    | Prettier                                     |
| `pnpm db:up` / `pnpm db:down`                          | Services Docker de développement             |
| `pnpm --filter @footfive/api db:seed:demo`             | Données de démonstration (dev)               |
| `pnpm --filter @footfive/api db:create-admin -- email` | Promeut un compte existant en administrateur |

## Principes

- Les montants sont des **entiers** (DZD) ; les calculs financiers sont faits **uniquement côté serveur**.
- Le taux de commission n'est **jamais codé en dur** : il vient de règles configurables.
- Le fournisseur de paiement simulé (`PAYMENT_PROVIDER=fake`) est **refusé au démarrage en production**.
- Une redirection de paiement côté navigateur n'est **jamais** une preuve : seule la confirmation serveur fait foi.

## Dépannage (Windows)

Si `vitest` échoue avec `ERR_SWC_NATIVE_CACHE`, le dossier de cache SWC a des permissions jugées trop larges.
Définissez un cache local au projet :

```powershell
$env:SWC_NATIVE_BINDING_CACHE = "$PWD\.cache\swc"
```
