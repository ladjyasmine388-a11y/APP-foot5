# Administration, tableaux de bord et personnel (étape 9)

Toutes les routes `/admin/*` exigent le rôle **ADMIN**, relu **en base à chaque requête** : un rôle accordé ou retiré prend effet
immédiatement, le jeton ne fait pas foi. Les actions sensibles sont **auditées** (acteur, avant/après, motif, identifiant de requête).

## Complexes (`/admin/venues`)

| Décision | Depuis | Vers | Motif | Effet |
|---|---|---|---|---|
| `approve` | PENDING, REJECTED | APPROVED | facultatif | visible partout ; exige au moins un terrain actif |
| `reject` | PENDING | REJECTED | **obligatoire** | jamais visible ; le motif est communiqué aux gérants |
| `suspend` | APPROVED | SUSPENDED | **obligatoire** | masqué des recherches, plus de nouvelle réservation |
| `reinstate` | SUSPENDED | APPROVED | facultatif | de nouveau visible |

- La transition est **atomique et conditionnée à l'état de départ** (`UPDATE … WHERE status IN (…)`) : deux administrateurs qui
  décident en même temps ne peuvent pas se marcher dessus (le second reçoit 409).
- Les propriétaires et gérants reçoivent une notification (`VENUE_APPROVED` / `VENUE_SUSPENDED` / `VENUE_REJECTED`) + email ; le simple personnel non.
- Suspendre **n'annule pas** les réservations déjà confirmées (le gérant et les joueurs gèrent leur cas ; l'administration peut rembourser).
- La liste montre les demandes en attente d'abord, avec le contact des propriétaires, le taux de commission effectif et l'acompte.
- `PUT /admin/venues/:id/deposit-policy` : acompte propre à un complexe (les gérants ne le modifient pas eux-mêmes) ; `null` = règle par défaut.

## Utilisateurs (`/admin/users`)

Recherche (email, nom, téléphone, statut, rôle). **Bloquer** exige un motif, passe le compte à BLOCKED et **révoque toutes ses sessions** ;
la connexion est refusée (`ACCOUNT_BLOCKED`). Un administrateur ne peut bloquer ni lui-même ni un autre administrateur.

## Commission et paramètres

- **Une modification ne réécrit jamais une règle** : elle clôture l'ancienne (`validTo`) et en crée une nouvelle. Historique complet ; chaque
  réservation garde la règle et les montants **figés** à sa création. Verrou consultatif : des modifications simultanées s'appliquent l'une après l'autre
  (toujours une seule règle globale active).
- Taux global (`PUT /admin/commission/global`) ou propre à un complexe (`PUT/DELETE /admin/commission/venues/:id`). Bornes : 0 à 30 % (3 000 pb)
  et 0 à 100 000 de fixe, pour qu'une faute de frappe (100 au lieu de 1) ne ruine pas les gérants.
- Paramètres modifiables : durée du verrou de paiement, préavis minimal, horizon de réservation, réservations en attente simultanées, acompte par
  défaut, politique d'annulation par défaut. **Chaque clé a sa validation** ; une clé inconnue est refusée.

## Remboursements et avis

- `GET /admin/refunds` (filtre par statut). **Relancer un échec** crée une *nouvelle* demande pour le solde du paiement : le prestataire mémorise le
  résultat par identifiant de remboursement, rejouer l'ancien renverrait le même échec. L'ancienne ligne reste dans l'historique. La réservation est verrouillée
  (deux clics = une seule relance).
- `POST /admin/bookings/:id/refund` : rembourse tout ce qui a été payé et pas déjà remboursé (litige, geste commercial), sans annuler la réservation.
- Avis : masquer / rétablir (motif obligatoire) ; la note du complexe est recalculée dans la même transaction, sous verrou.

## Statistiques

- `GET /admin/stats?from&to` (366 jours au plus) : utilisateurs, complexes par statut, réservations par statut, chiffre d'affaires, commission,
  remboursements, matchs, série journalière sans trous, top 5 des complexes.
- `GET /manage/venues/:id/stats?from&to` (gérant au moins) : réservations, revenus, commission, part du complexe, acomptes en ligne / solde sur place,
  heures réservées, taux de no-show, répartition par heure et par terrain. Un gérant ne voit jamais un autre complexe (404).
- `GET /me/stats` : mon tableau de bord de joueur.
- **Chiffre d'affaires = réservations CONFIRMÉES ou JOUÉES** (jamais annulées, expirées, en attente, ni les blocages). Les jours de service suivent le fuseau du complexe.

## Journal d'audit (`GET /admin/audit-logs`)

Filtres : action (préfixe), entité, acteur, période ; paginé. Lecture seule (un trigger SQL interdit toute modification), sans secret.

## Personnel d'un complexe (`/manage/venues/:id/staff`)

Lister : gérant. Ajouter (par email d'un compte actif), changer un rôle, retirer : **propriétaire**. Chacun peut quitter le complexe de lui-même.
**Un complexe garde toujours au moins un propriétaire** (vérifié sous verrou : deux propriétaires qui partent en même temps ne le laissent pas orphelin).

## Correctif découvert pendant cette étape : fuseau de la session PostgreSQL

Les dates passées en paramètre d'un `$queryRaw` partent **sans fuseau** et étaient lues dans le fuseau de la session PostgreSQL. Sur un serveur configuré en
heure locale (ici `Africa/Lagos`, UTC+1), tout le SQL brut (maintenance des réservations, des matchs, rappels, statistiques) était **décalé d'une heure**.
La session est désormais forcée en UTC (`infra/database/pg-adapter.ts`) ; un test de non-régression le garantit.
