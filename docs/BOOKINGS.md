# Réservations, commission et verrou de paiement

## Cycle de vie

```
            réserver                paiement confirmé par le serveur
 (libre) ───────────► PENDING_PAYMENT ───────────────────────────────► CONFIRMED ──► COMPLETED
                         │  │                                             │  │
        verrou dépassé   │  └─ annulation du joueur ──► CANCELLED ◄───────┘  └─► NO_SHOW (marqué par le complexe)
                         ▼                                 (joueur ou complexe)
                      EXPIRED
```

Seuls `CANCELLED` et `EXPIRED` libèrent le créneau. `AVAILABLE` n'est pas un statut : c'est l'absence de réservation active.
Le paiement (passage à `CONFIRMED`) arrive à l'étape 6 ; l'étape 5 livre tout ce qui précède.

## Réserver : ce que fait le serveur

`POST /bookings` (en-tête **`Idempotency-Key` obligatoire**, e-mail vérifié exigé) reçoit **uniquement** `{ fieldId, startsAt,
paymentMode }`. Aucun montant n'est accepté : un champ `priceMinor`, `commissionMinor`, `status`, `userId`… est refusé (400).

1. **Rejeu** : si ce joueur a déjà un verrou valide sur ce créneau, on le lui rend (pas de doublon).
2. **Créneau réel** : `startsAt` doit être le début exact d'un créneau de la grille (horaires, durée), libre, tarifé, dans l'horizon
   de réservation et le préavis minimal. Sinon : 404 (terrain inconnu ou complexe non public), 422 `SLOT_NOT_BOOKABLE`
   (inexistant, passé, sans tarif), 409 `SLOT_UNAVAILABLE` (pris).
3. **Anti-accaparement** : au plus 3 verrous simultanés par joueur (`booking.max_active_holds`), 409 `TOO_MANY_HOLDS` au-delà.
4. **Montants** : prix, commission et acompte sont **calculés ici** puis **figés** dans la réservation.
5. **Écriture** (`BookingWriter`) : les verrous périmés qui chevauchent passent à `EXPIRED`, puis la réservation est insérée
   avec un verrou de `booking.hold_minutes` (10 min). Si deux requêtes visent le même créneau, **la contrainte d'exclusion
   PostgreSQL en refuse une** (23P01 → 409). C'est la base, pas le code, qui garantit l'unicité.

`POST /bookings/quote` donne prix et acompte sans rien écrire. La commission n'est jamais montrée au joueur.

### Pourquoi un verrou périmé ne bloque pas le créneau

La contrainte d'exclusion ignore l'horloge. Un verrou dépassé est donc traité libre **partout** sans attendre un nettoyage :
la disponibilité l'ignore, `BookingWriter` l'expire avant d'insérer, et les vues le montrent `EXPIRED`. La maintenance
périodique ne sert qu'à garder des statuts exacts en base.

## Argent

Entiers en DZD, jamais de flottants. Fonctions pures dans [`money.ts`](../apps/api/src/modules/bookings/money.ts),
testées par 5 000 tirages aléatoires qui vérifient les mêmes règles que les contraintes `CHECK` de la base.

```
commission  = min(prix, ⌊prix × tauxBps / 10 000⌋ + fixe)     ← arrondi à l'inférieur : le reliquat va au complexe
part complexe   = prix − commission
part plateforme = commission + frais de service
total payé      = prix + frais + taxes
acompte (DEPOSIT) = min(total, max(pourcentage ou montant fixe, plancher, part plateforme))   ← arrondi au supérieur
```

Exemple (taux initial 1 %, acompte 20 %) : créneau à 4 000 DA → commission **40 DA**, part du complexe **3 960 DA**,
acompte en ligne **800 DA**, **3 200 DA** à régler sur place.

- **Règle de commission** : la plus spécifique l'emporte — complexe > type de réservation > globale — parmi les règles actives.
  La règle appliquée et son taux sont **figés** dans la réservation : modifier la commission ne change jamais l'historique.
  Sans aucune règle active, les réservations sont refusées (503) plutôt que vendues sans commission.
- **Acompte** : politique du complexe (`Venue.depositPolicy`), sinon paramètre plateforme `booking.default_deposit`, sinon 20 %.
  Il couvre **toujours** au moins la part de la plateforme (sinon la commission ne serait pas encaissée).
- **Modes de paiement pour un joueur** : `DEPOSIT` (défaut) ou `FULL_ONLINE`. Le paiement 100 % sur place n'est pas ouvert aux
  joueurs. Les réservations saisies par le complexe n'ont **aucune commission**.

## Idempotence

`Idempotency-Key` (8–128 caractères). Même clé + même contenu → la réponse du premier appel est rejouée (en-tête
`Idempotent-Replayed: true`) ; même clé + contenu différent → 422 `IDEMPOTENCY_KEY_REUSED` ; requête identique encore en
cours → 409 `REQUEST_IN_PROGRESS` ; échec → la clé est libérée. Clés valables 24 h, purgées par la maintenance.

## Annulation

| Qui                | Quand                                    | Résultat                                                      |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------- |
| Joueur             | `PENDING_PAYMENT`                        | annulée, créneau libéré                                       |
| Joueur             | `CONFIRMED`, ≥ N h avant (24 h défaut)   | annulée, **remboursement intégral** demandé                   |
| Joueur             | `CONFIRMED`, < N h avant                 | annulée ; l'acompte reste acquis (sauf `refundDeposit: true`) |
| Complexe (MANAGER) | `PENDING_PAYMENT` ou `CONFIRMED` à venir | annulée, **toujours remboursé intégralement**                 |
| personne           | créneau commencé, terminé, expiré        | 409 `BOOKING_NOT_CANCELLABLE`                                 |

N est la politique du complexe (`Venue.cancellationPolicy`), sinon `booking.default_cancellation_policy`. Le remboursement est
**demandé** dans la même transaction que l'annulation (`Refund` au statut `REQUESTED`) ; l'exécution auprès du prestataire
de paiement est l'objet de l'étape 6. Le passage à `CANCELLED` est conditionnel (`WHERE status IN (…)`) : deux annulations
simultanées, ou une annulation face à une confirmation de paiement, ne peuvent pas toutes les deux réussir.

## Côté complexe

| Route                                         | Rôle min. | Effet                                                                       |
| --------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `GET  /manage/venues/:id/bookings?from&to`    | STAFF     | calendrier (≤ 62 jours) avec contact du client, commission et part nette    |
| `POST /manage/venues/:id/bookings`            | STAFF     | réservation par téléphone/sur place : confirmée, sans commission, sur place |
| `POST /manage/venues/:id/blocks`              | MANAGER   | bloque une période (≤ 31 j) ; 409 avec la liste des réservations gênantes   |
| `DELETE /manage/venues/:id/blocks/:bookingId` | MANAGER   | lève le blocage                                                             |
| `POST …/bookings/:bookingId/cancel`           | MANAGER   | annule (raison obligatoire), remboursement intégral du client               |
| `POST …/bookings/:bookingId/no-show`          | STAFF     | joueur absent une fois le créneau commencé : fiabilité −10 points           |

Un blocage est une réservation `BLOCK` : la **même** contrainte d'exclusion garantit qu'il ne chevauche jamais une
réservation. Les statistiques de revenus doivent donc exclure ce type.

## Maintenance (toutes les 30 s)

`BookingsMaintenanceService` : verrous périmés → `EXPIRED` ; réservations terminées → `COMPLETED` (et `matchesPlayed` du joueur,
compté seulement pour les lignes réellement passées à `COMPLETED`) ; purge des clés d'idempotence. Un verrou consultatif
PostgreSQL (`pg_try_advisory_xact_lock`) garantit qu'une seule instance de l'API l'exécute. Minuterie interne pour le MVP ;
une file de tâches (pg-boss) prendra le relais avec les rappels et notifications.

## Garanties vérifiées par les tests

- 2 puis 20 joueurs simultanés sur le même créneau : **un seul gagnant**, les autres reçoivent 409 `SLOT_UNAVAILABLE`.
- Joueur contre complexe, et personnel contre personnel, simultanés : un seul gagnant.
- 5 requêtes identiques simultanées (même clé) : une seule réservation.
- 5 annulations simultanées : une seule réussit, un seul remboursement demandé.
- Aucun montant, statut, verrou ou identifiant ne peut être imposé par le client.
