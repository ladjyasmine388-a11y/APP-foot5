# Modèle de données

Source de vérité : [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma) et les migrations
SQL dans `apps/api/prisma/migrations/`. Ce document explique **pourquoi** le modèle est ainsi.

## Conventions

- Identifiants **UUID v7** (triables par date de création).
- Dates en **`TIMESTAMPTZ`**, toujours stockées en UTC. Le fuseau (`Africa/Algiers`) est porté par le complexe.
- **Argent = entiers en unité mineure (DZD)**, jamais de flottants. Taux en **points de base** (100 bps = 1 %).
- Horaires d'ouverture et plages tarifaires en **minutes depuis minuit, heure locale du complexe**
  (`closesAtMin` peut dépasser 1440 pour une fermeture après minuit).

## Les garanties vivent dans la base

Ce que Prisma ne sait pas exprimer est écrit en SQL (`*_db_guarantees/migration.sql`). Elles tiennent même
si le code applicatif a un bug ou si deux requêtes arrivent en même temps.

| Garantie                                                                                  | Mécanisme                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Un terrain n'est jamais occupé deux fois en même temps                                    | `EXCLUDE USING gist` sur `Booking` (`Booking_no_overlap`) |
| Montants cohérents : `total = base + frais + taxes`, `complexe = base − commission`, etc. | `CHECK` sur `Booking`                                     |
| Un verrou de paiement a toujours une date d'expiration                                    | `CHECK` sur `Booking`                                     |
| Une réservation vise un terrain **du même complexe** (isolation multi-tenant)             | Clé étrangère composite `(fieldId, venueId)`              |
| Une seule règle de commission active par portée                                           | Index unique partiel sur `CommissionRule`                 |
| Pas de surbooking d'une session (`0 ≤ joinedCount ≤ capacity`)                            | `CHECK` sur `SoloSession`                                 |
| Un seul adversaire accepté par annonce ; un seul capitaine actif par équipe               | Index uniques partiels                                    |
| Email en minuscules (pas de doublon `Yas@x.com` / `yas@x.com`)                            | `CHECK` sur `User`                                        |
| Le journal d'audit ne peut être ni modifié ni effacé                                      | Trigger `AuditLog_immutable`                              |

### Statuts qui occupent un créneau

`PENDING_PAYMENT`, `CONFIRMED`, `COMPLETED`, `NO_SHOW`. Seuls `CANCELLED` et `EXPIRED` libèrent le terrain.
Un créneau passé reste occupé : on ne réécrit pas l'historique.

`AVAILABLE` n'est **pas** un statut stocké : c'est l'absence de réservation active. Le verrou temporaire
(_hold_) est une réservation `PENDING_PAYMENT` avec `holdExpiresAt`.

### Blocages = réservations de type `BLOCK`

Un créneau bloqué par le complexe est une ligne de `Booking` (`bookingType = BLOCK`, sans client ni montant).
Ainsi la **même** contrainte garantit qu'un blocage ne chevauche jamais une réservation, et inversement.
Toute requête de statistiques ou de revenus doit donc exclure `BLOCK`.

## Relations

```
User 1─* Session / AuthIdentity / EmailToken / Notification / Booking / Review
User 1─1 PlayerStats                     (fiabilité : calculée par le serveur uniquement)
User *─* Team            via TeamMember  (un seul capitaine actif par équipe)
User *─* Venue           via VenueStaff  (OWNER / MANAGER / STAFF)
Team 1─* TeamInvitation

Venue 1─* Field 1─* PricingRule
Venue 1─* OpeningHour    (surcharge possible par terrain)
Field 1─* Booking ─ (fieldId, venueId) → Field(id, venueId)

Booking 1─* Payment 1─* Refund
Booking 1─0..1 SoloSession 1─* SoloPlayer
Booking 1─0..1 OpponentListing 1─* MatchRequest
Booking 1─0..1 Match 1─* MatchParticipant   (Match : équipe A, équipe B nullable)
Booking 1─0..1 Review

CommissionRule  (GLOBAL | VENUE | BOOKING_TYPE)  — appliquée puis figée dans Booking
```

## Rôles et permissions

- **Global** : `User.platformRole` = `USER` ou `ADMIN`.
- **Contextuel** : le capitaine d'une équipe (`TeamMember.role`) et le staff d'un complexe
  (`VenueStaff.role`) ne sont pas des rôles globaux : un même compte peut être joueur, capitaine
  et gérant de complexe.
- Les permissions sont définies **en code** (politiques testées), pas dans des tables `Role`/`Permission`.

## Commission et acompte

- Le taux n'est **jamais** codé en dur : `CommissionRule` (global, par complexe, par type de réservation).
  Résolution : `VENUE` > `BOOKING_TYPE` > `GLOBAL`. Valeur initiale : **1 %**.
- `commission = floor(base × rateBps / 10 000) + fixe`. Exemple : 4 000 DA → 40 DA de commission,
  3 960 DA pour le complexe.
- À la création de la réservation, tous les montants sont **figés** (`Booking`) : modifier une règle
  plus tard ne réécrit jamais l'historique.
- L'**acompte** demandé en ligne est un paramètre distinct de la commission
  (`PlatformSetting` `booking.default_deposit`, surchargeable par `Venue.depositPolicy`).

## Multi-tenant

Le complexe (`Venue`) est le locataire. `venueId` est dénormalisé sur `Booking` ; toute requête du
dashboard complexe est filtrée par `venueId`, et la clé étrangère composite interdit à une réservation
de pointer vers un terrain d'un autre complexe.

## Évolutions prévues (sans refonte)

`Payout` / `LedgerEntry` (reversements), `Media` (uploads), abonnements premium, réservations récurrentes,
statistiques de match (buts, passes), géographie avancée (PostGIS).
