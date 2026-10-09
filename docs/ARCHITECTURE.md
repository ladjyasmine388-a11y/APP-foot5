# Architecture

Vue d'ensemble de Foot Five : ce qui existe, comment les pièces s'articulent et **pourquoi** les choix structurants ont été faits.
Chaque domaine a son document détaillé (liens en bas).

## Vue d'ensemble

```
Navigateur (React, AR/FR/EN + RTL)          Futur mobile (même API)
            │                                         │
            └──────────────  HTTPS  /api/v1  ────────┘
                               │
                    nginx (prod) / proxy Vite (dev)
                               │
                  API NestJS + Fastify (apps/api)
        ┌──────────┬───────────┼────────────┬─────────────┐
     Modules    Domain      Prisma +     Stockage     Courrier
     métier     events      pg adapter   (local)      (SMTP)
                               │
                        PostgreSQL 16
          (contraintes, verrous, journal d'audit immuable)
```

Un seul processus API, une seule base. C'est volontaire : la cohérence des réservations repose sur PostgreSQL (contrainte
d'exclusion, verrous de ligne), pas sur un composant distribué. Voir [ROADMAP.md](ROADMAP.md) pour la mise à l'échelle.

## Monorepo

| Dossier           | Contenu                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`        | API REST (NestJS 12, Fastify, Prisma 7, Zod 4). Même API pour le web et le futur mobile.                                      |
| `apps/web`        | Application web (React 19, Vite, Tailwind v4, TanStack Query, React Router). Trilingue, RTL.                                  |
| `packages/shared` | Enums, types et **schémas Zod partagés** : le contrat entre API et clients. À reconstruire (`pnpm build`) après modification. |
| `packages/config` | Configurations TypeScript / ESLint partagées.                                                                                 |
| `e2e`             | Tests de bout en bout Playwright (navigateur réel, API compilée, base dédiée).                                                |
| `docker`          | Compose de développement, Dockerfiles et nginx de production.                                                                 |

## Modules de l'API (`apps/api/src/modules`)

| Module                                                              | Responsabilité                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `auth`, `users`                                                     | Inscription, vérification d'email, connexion, jetons rotatifs, rôles, profil                     |
| `venues`, `availability`                                            | Complexes, terrains, tarifs, horaires, créneaux de 60 min, fermetures, personnel du complexe     |
| `bookings`, `policies`                                              | Réservation avec verrou temporaire, annulation, politique d'annulation et d'acompte              |
| `payments`                                                          | `PaymentProvider` abstrait, webhooks signés, remboursements, prestataire simulé                  |
| `settings`, `admin`                                                 | Commission configurable, paramètres, modération, utilisateurs, tableaux de bord                  |
| `teams`, `solo`/`solo-sessions`, `opponents`, `matches`, `matching` | Équipes, « Complétez votre équipe », « Trouvez un adversaire », matchs, classement des candidats |
| `notifications`, `reviews`, `uploads`                               | Notifications (in-app + email), rappels, avis, images                                            |
| `audit`, `health`                                                   | Journal d'audit immuable, sondes de santé                                                        |

## Principes qui structurent le code

1. **Le serveur est la seule autorité financière.** Prix, commission, acompte, remboursement : calculés côté serveur, en entiers
   (DZD). Le client n'envoie jamais un montant. Le taux de commission (1 % = 100 bps par créneau horaire) vient de règles
   configurables en base, jamais d'une constante ([PAYMENTS.md](PAYMENTS.md)).
2. **Les invariants vivent dans la base.** Une double réservation est impossible même si le code a un bug : contrainte
   d'exclusion `gist`, `CHECK` de cohérence des montants, index uniques partiels, trigger d'immutabilité de l'audit
   ([DATA-MODEL.md](DATA-MODEL.md)).
3. **Transitions d'état idempotentes.** Chaque changement d'état est un `UPDATE … WHERE état = attendu` ; un webhook rejoué ou une
   double requête ne produit jamais deux effets.
4. **Verrous explicites pour les tâches de fond.** Expiration des verrous, rappels, maintenance sociale, recalcul de commission :
   verrous consultatifs PostgreSQL (727001, 727002, 727003, 727010) pour qu'une seule instance travaille à la fois.
5. **Événements de domaine après validation.** Les notifications et emails sont déclenchés par un bus d'événements **après** le
   commit : un échec d'envoi n'annule jamais une réservation.
6. **Multi-tenant par construction.** Chaque requête gérant un complexe est bornée par les complexes du compte (propriétaire ou
   personnel) ; les clés étrangères composites interdisent de rattacher une réservation au terrain d'un autre complexe.
7. **Heures : UTC en base, Alger à l'écran.** La session PostgreSQL est forcée en UTC (`infra/database/pg-adapter.ts`) ; le fuseau
   d'affichage est porté par le complexe. Un test de régression couvre un décalage d'une heure réellement rencontré.
8. **Aucune preuve côté navigateur.** Une redirection de paiement n'est pas une confirmation ; seul le webhook signé fait foi.

## Application web

Pages chargées à la demande, jeton d'accès **en mémoire** (jamais dans `localStorage`), cookie de rafraîchissement `httpOnly`
limité à `/api/v1/auth`. Internationalisation typée maison : chaque clé porte ses trois langues côte à côte, une clé manquante
est une erreur de compilation. Propriétés CSS logiques partout, donc l'arabe bascule en RTL sans styles dupliqués.
Détails : [WEB.md](WEB.md).

## Rôles

`PLAYER`, `VENUE_OWNER`, `VENUE_STAFF` (rattaché à un complexe, droits limités), `ADMIN`. Les gardes sont déclaratives
(`auth.decorators.ts`) et les tests d'intégration vérifient les refus (403) et l'isolation entre complexes.

## Documentation par domaine

[DATA-MODEL](DATA-MODEL.md) · [AUTH](AUTH.md) · [AVAILABILITY](AVAILABILITY.md) · [BOOKINGS](BOOKINGS.md) · [PAYMENTS](PAYMENTS.md) ·
[SOCIAL](SOCIAL.md) · [NOTIFICATIONS](NOTIFICATIONS.md) · [ADMIN](ADMIN.md) · [WEB](WEB.md) · [SECURITY](SECURITY.md) ·
[TESTING](TESTING.md) · [DEPLOYMENT](DEPLOYMENT.md) · [ROADMAP](ROADMAP.md)
