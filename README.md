# Foot Five

Plateforme de réservation de terrains de **Foot Five** et de mise en relation :
réservez un créneau, complétez votre équipe, trouvez un adversaire.

> **Statut : développement en cours** — étape 1/11 (fondations) terminée.
> La documentation complète (architecture, déploiement, comptes de démo) sera finalisée en fin de projet.

## Stack

| Couche          | Technologie                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Web             | React 19, Vite, TypeScript (Tailwind, TanStack Query, React Router, i18n AR/FR/EN + RTL à l'étape 10) |
| API             | NestJS 12 (Fastify), TypeScript, Zod, OpenAPI                                                         |
| Base de données | PostgreSQL 16 + Prisma (étape 2)                                                                      |
| Monorepo        | pnpm workspaces + Turborepo                                                                           |
| Infra locale    | Docker Compose (PostgreSQL, Mailpit, MinIO)                                                           |

## Structure

```
apps/
  api/        API REST (NestJS) — même API pour le web et le futur mobile
  web/        Application web (React, PWA mobile-first)
packages/
  shared/     Enums, types et schémas Zod partagés
  config/     Configurations TypeScript / ESLint partagées
docker/       Docker Compose de développement
docs/         Documentation d'architecture
```

## Démarrage rapide

Prérequis : Node.js ≥ 22, pnpm (`npm i -g pnpm`), Docker Desktop.

```bash
pnpm install
cp .env.example .env        # puis adapter si besoin
pnpm db:up                  # PostgreSQL (port 5433), Mailpit (8025), MinIO (9001)
pnpm build                  # construit packages/shared (requis par api et web)
pnpm --filter @footfive/api dev
pnpm --filter @footfive/web dev
```

- API : <http://localhost:3000/api/v1/health>
- Web : <http://localhost:5173>
- Emails de dev (Mailpit) : <http://localhost:8025>

## Commandes

| Commande                            | Rôle                             |
| ----------------------------------- | -------------------------------- |
| `pnpm build`                        | Compile tous les paquets         |
| `pnpm lint`                         | ESLint                           |
| `pnpm typecheck`                    | Vérification des types           |
| `pnpm test`                         | Tests (Vitest)                   |
| `pnpm format` / `pnpm format:check` | Prettier                         |
| `pnpm db:up` / `pnpm db:down`       | Services Docker de développement |

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
