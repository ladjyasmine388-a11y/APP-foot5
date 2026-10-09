# Complexes, tarifs et disponibilités

## Principe : les créneaux sont CALCULÉS, pas stockés

Aucune table de créneaux. Pour un terrain et un jour, le moteur
([`availability.engine.ts`](../apps/api/src/modules/availability/availability.engine.ts), fonctions pures) combine :

```
horaires d'ouverture  →  créneaux de N minutes  →  prix (règles)  →  réservations existantes  →  statut
```

Avantages : changer un horaire ou un tarif est pris en compte **immédiatement**, sans régénérer de lignes ni risquer
d'incohérence. La disponibilité affichée est **indicative** : la garantie qu'un créneau n'est jamais vendu deux fois est
la contrainte d'exclusion PostgreSQL (voir [DATA-MODEL.md](DATA-MODEL.md)), pas ce calcul.

## Jour de service et fermeture après minuit

Les horaires sont en **minutes depuis minuit, heure locale du complexe** et rattachés au **jour de service**.
Un complexe ouvert le vendredi de `10:00` à `02:00` est stocké `600 → 1560` : les créneaux 00:00–02:00 (techniquement la
nuit de samedi) appartiennent au **vendredi**. À la saisie : `to` ≤ `from` signifie « le lendemain ». Fermeture maximale :
06:00. Le fuseau (`Venue.timezone`, défaut `Africa/Algiers`) est appliqué par `localToUtc`, qui gère aussi les changements
d'heure.

## Résolution des horaires

Pour un terrain et un jour : si le terrain a **ses propres** horaires ce jour-là, ils remplacent ceux du complexe ;
sinon on prend ceux du complexe ; aucune plage = fermé. Plusieurs plages par jour sont possibles (pause déjeuner).
Limite : un terrain ne peut pas être « fermé tel jour » alors que le complexe est ouvert — utiliser un blocage ou le
désactiver.

Les créneaux sont alignés sur l'ouverture de la plage ; un créneau incomplet à la fermeture est ignoré.
Durée par terrain : `Field.slotDurationMin` (60 par défaut, multiple de 30 jusqu'à 240).

## Résolution du prix

Règle **active** couvrant le **début** du créneau (jour de la semaine, tranche horaire `[début, fin[`, période de
validité incluse). Plusieurs règles → la plus **prioritaire** ; à priorité égale, la plage la plus **étroite** ; puis
l'identifiant (déterminisme). Aucune règle → `NO_PRICE` : le créneau n'est pas vendable et n'est pas montré au public.

Garde-fous : prix entier en DZD entre 1 et 100 000 (une faute de frappe « 400 000 » est refusée).

## Statuts d'un créneau

| Statut      | Sens                                                | Visible du public comme |
| ----------- | --------------------------------------------------- | ----------------------- |
| `AVAILABLE` | libre et vendable                                   | `AVAILABLE`             |
| `HELD`      | quelqu'un est en train de payer (verrou non expiré) | `HELD`                  |
| `BOOKED`    | réservation confirmée / terminée / no-show          | `UNAVAILABLE`           |
| `BLOCKED`   | fermé par le complexe                               | `UNAVAILABLE`           |
| `PAST`      | déjà commencé, ou à moins du préavis minimal        | `UNAVAILABLE`           |
| `NO_PRICE`  | aucun tarif applicable                              | masqué                  |

Le public ne voit **pas pourquoi** un créneau est indisponible : ce serait révéler le taux de remplissage du complexe.
Un verrou de paiement **dépassé** est considéré libre immédiatement, sans attendre le job d'expiration.

## Paramètres réglables par l'admin (`PlatformSetting`)

| Clé                        | Défaut | Rôle                                        |
| -------------------------- | ------ | ------------------------------------------- |
| `booking.min_lead_minutes` | 30     | préavis minimal avant le début d'un créneau |
| `booking.max_days_ahead`   | 60     | horizon de réservation                      |

## Recherche (`GET /venues`)

Filtres : ville, quartier, nom, équipements (tous exigés), nombre de joueurs (terrains assez grands), **date + heure**
(créneaux réellement libres, avec tolérance `window`), prix max (sur le créneau réel quand une date est donnée), position

- rayon, tri (pertinence, prix, note, distance), pagination par curseur. Seuls les complexes **approuvés** avec au moins un
  terrain actif sont visibles.

**Passage à l'échelle** : la recherche par date charge jusqu'à 300 complexes candidats et calcule leurs créneaux en
mémoire, avec **une seule requête de réservations** (pas de N+1). Suffisant pour des centaines de complexes. Au-delà :
précalculer la disponibilité (table de cache invalidée à chaque réservation), PostGIS pour la distance, et un index de
recherche texte.

Limite connue : le filtre de ville est insensible à la casse mais **pas aux accents ni aux variantes** (« Alger » ≠
« Algiers »). Une table de villes normalisées est prévue.

## Droits (espace complexe, `/manage/venues/...`)

| Rôle                 | Lecture (fiche, calendrier, tarifs)      | Écriture (infos, terrains, horaires, tarifs) |
| -------------------- | ---------------------------------------- | -------------------------------------------- |
| `STAFF`              | oui                                      | non (403)                                    |
| `MANAGER`            | oui                                      | oui                                          |
| `OWNER`              | oui                                      | oui                                          |
| `ADMIN` (plateforme) | oui                                      | oui                                          |
| non-membre           | **404** (le complexe n'est pas confirmé) | **404**                                      |

Vérifié dans les **services** (`PoliciesService`), pas seulement par des gardes. Un terrain n'est atteignable que par
son propre complexe : un identifiant d'un autre complexe donne 404. Les politiques financières (acompte) et le statut
(`PENDING` / `APPROVED` / `SUSPENDED`) ne sont modifiables que par l'administration de la plateforme.

Toute modification sensible (complexe, terrain, horaires, **prix**) est inscrite dans le journal d'audit, avec l'ancienne
et la nouvelle valeur.
