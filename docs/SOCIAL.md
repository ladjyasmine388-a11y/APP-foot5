# Équipes, sessions « Complétez votre équipe », adversaires et matchs (étape 7)

## Principes

- **Tout repose sur une réservation CONFIRMÉE.** Une session, une annonce ou un match est toujours rattaché à une
  réservation (acompte payé, ou réservation manuelle du complexe), à venir, de type standard, et **utilisée une seule
  fois** (`SoloSession.bookingId`, `OpponentListing.bookingId`, `Match.bookingId` sont uniques). La ligne de la
  réservation est verrouillée (`FOR UPDATE`) pendant la création : deux requêtes simultanées ne peuvent pas la
  détourner vers deux activités. Une réservation d'autrui est indiscernable d'une réservation inexistante (404).
- **Le règlement entre joueurs se fait hors plateforme** (entre joueurs, sur place). Seule la réservation du terrain,
  faite par l'hôte, passe par la plateforme. `pricePerPlayerMinor` est **indicatif**.
- **Annuler une activité n'annule jamais la réservation** (qui suit sa propre politique de remboursement).
  L'inverse est vrai : annuler la réservation arrête tout ce qui en dépend (cascade).

## Équipes

| Règle       | Détail                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Création    | email vérifié ; 3 équipes dirigées au maximum (`TEAM_LIMIT_REACHED`) ; nom unique, insensible à la casse (index SQL)                                                                                                                                                |
| Capitaine   | un seul par équipe (index partiel) ; transfert possible ; un capitaine avec coéquipiers doit transférer avant de partir ; seul, il dissout l'équipe en partant                                                                                                      |
| Effectif    | 25 membres maximum ; l'effectif n'est visible que des membres ; jamais d'email/téléphone/date de naissance                                                                                                                                                          |
| Invitations | par compte ou par email, valables 7 jours, 30 en attente maximum, 30 envois/jour ; un email inconnu reçoit un message ; une invitation par email n'est acceptable qu'avec **cette adresse vérifiée** ; acceptation atomique (usage unique, `TEAM_FULL` si complète) |
| Dissolution | refusée tant qu'une annonce ouverte ou un match à venir existe ; le nom redevient disponible                                                                                                                                                                        |

## Sessions « Complétez votre équipe »

- Créées par le **joueur-hôte** (sa réservation ; il occupe une place : au plus `capacité du terrain − 1` places) ou par
  le **personnel du complexe** (`POST /manage/venues/:venueId/solo-sessions` ; toutes les places comptent ; l'identité du
  membre du personnel n'est pas exposée : l'hôte affiché est le complexe).
- **Jamais de surréservation** : l'inscription verrouille la ligne de la session, vérifie `joinedCount < capacity`, puis
  incrémente. Test : 12 joueurs pour 3 places en parallèle → exactement 3 inscrits.
- Règles d'inscription : session ouverte et non commencée (`SESSION_CLOSED`), place libre (`SESSION_FULL`), pas déjà
  inscrit (`ALREADY_JOINED`), niveau compatible ±1 (`LEVEL_INCOMPATIBLE`, via `MatchingStrategy`), aucun autre match qui
  chevauche le créneau (`SCHEDULE_CONFLICT`).
- Quitter est possible jusqu'au début ; la session rouvre. Un match (`SOLO_SESSION`) est créé avec la session et suit
  les inscriptions.
- Liste publique (`GET /solo-sessions`) : filtres ville, complexe, date, heure ± fenêtre, niveau, places ; tri
  `soonest` | `spots` (les plus proches d'être complètes) | `recommended` (connecté, via la stratégie de mise en
  relation). Hors connexion : pas de liste de joueurs, hôte abrégé (« Prénom N. »). Les 300 sessions les plus proches
  sont classées en mémoire (limite assumée du MVP).
- **Mise en relation remplaçable** : tout passe par `MatchingStrategy` (`modules/matching`). Un algorithme plus fin
  (position, distance, historique, fiabilité…) se branche en changeant un seul provider.

## Trouvez un adversaire

1. Le capitaine publie une annonce sur **sa** réservation (`POST /opponent-listings`). Format par défaut : le plus grand
   que le terrain et l'effectif permettent (5 à 8 par équipe) ; `TEAM_TOO_SMALL` si l'équipe n'a pas assez de joueurs ;
   le format ne peut pas dépasser la moitié de la capacité du terrain. Niveau par défaut = niveau de l'équipe.
2. Le capitaine d'une **autre** équipe demande à jouer (une demande active par équipe, 20 en attente au maximum ; niveau
   ±1 ; effectif suffisant ; pas de match concurrent ; un capitaine ne joue pas des deux côtés).
3. Le capitaine annonceur **accepte une demande** : l'annonce est verrouillée, la demande acceptée, les autres rejetées,
   l'annonce passe à `ACCEPTED` et un match `OPPONENT_LISTING` est créé avec les deux effectifs (côtés A/B). Deux
   acceptations simultanées → un seul match (verrou + index partiel).
4. Annulation : l'annonceur annule tout (annonce comprise) ; l'équipe adverse **se retire** : le match disparaît,
   l'annonce se rouvre et sa demande passe à `CANCELLED`.

## Matchs

- Match d'équipe (`POST /matches`) : entraînement ou match interne sur sa propre réservation.
- Visibles des participants, des membres des équipes, du créateur et du personnel du complexe ; sinon 404.
- **Score** (`PUT /matches/:id/score`) : par l'un des deux capitaines, **après la fin**, **écriture unique** (un litige se
  règle avec le complexe / l'administrateur), uniquement entre deux équipes.
- Limite connue : les participants d'un match d'équipes sont les effectifs au moment de l'acceptation (la confirmation
  de présence viendra avec les notifications).

## Cycle de vie et maintenance (`SocialMaintenanceService`, toutes les 30 s, verrou 727002)

1. `booking.cancelled` / `booking.expired` → cascade immédiate (session, annonce, demandes, match).
   Le balayage périodique rattrape les événements perdus.
2. Annonce `OPEN` dont l'heure est passée → `EXPIRED` (demandes en attente rejetées).
3. Match dont l'heure de fin est passée → `COMPLETED` ; `PlayerStats.matchesPlayed` crédité **une seule fois** (le client
   de la réservation est exclu : la maintenance des réservations le compte déjà).

Toutes les transitions sont idempotentes (`updateManyAndReturn` filtré sur l'état attendu).

## Événements émis (consommés par les notifications à l'étape 8)

`team.invitation_created`, `team.invitation_accepted`, `team.member_removed`, `solo.player_joined`, `solo.player_left`,
`solo.full`, `solo.cancelled`, `opponent.request_created`, `opponent.request_accepted`, `opponent.request_rejected`,
`match.cancelled`.

## Codes d'erreur

`NOT_CAPTAIN`, `TEAM_LIMIT_REACHED`, `TEAM_FULL`, `TEAM_TOO_SMALL`, `ALREADY_JOINED`, `SESSION_FULL`, `SESSION_CLOSED`,
`SCHEDULE_CONFLICT`, `LEVEL_INCOMPATIBLE`, `BOOKING_NOT_ELIGIBLE`.
