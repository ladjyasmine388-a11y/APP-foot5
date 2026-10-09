# Notifications, emails, avis et images (étape 8)

## Notifications

Chaque événement métier (`DomainEvents`, émis APRÈS la validation de la transaction) produit une notification dans
l'application et, pour les types importants, un email **dans la langue du compte** (ar / fr / en, heure d'Alger).

| Événement                                   | Type                                 | Destinataire          | Email |
| ------------------------------------------- | ------------------------------------ | --------------------- | ----- |
| `booking.confirmed`                         | `BOOKING_CONFIRMED`                  | client                | oui   |
| `booking.cancelled`                         | `BOOKING_CANCELLED`                  | client                | oui   |
| `booking.expired`                           | `BOOKING_EXPIRED`                    | client                | oui   |
| `refund.processed`                          | `REFUND_PROCESSED`                   | client                | oui   |
| `team.invitation_created`                   | `TEAM_INVITATION_RECEIVED`           | invité (compte connu) | oui   |
| `team.invitation_accepted`                  | `TEAM_INVITATION_ACCEPTED`           | capitaine             | non   |
| `solo.player_joined` (≤ 2 places restantes) | `SOLO_ALMOST_FULL`                   | hôte                  | non   |
| `solo.full`                                 | `SOLO_FULL`                          | hôte + joueurs        | oui   |
| `solo.cancelled`                            | `SOLO_CANCELLED`                     | joueurs + hôte        | oui   |
| `opponent.request_created`                  | `OPPONENT_REQUEST_RECEIVED`          | capitaine annonceur   | oui   |
| `opponent.request_accepted`                 | `OPPONENT_ACCEPTED`                  | capitaine demandeur   | oui   |
| `opponent.request_rejected`                 | `OPPONENT_REJECTED`                  | demandeur             | non   |
| `match.cancelled`                           | `MATCH_CANCELLED`                    | participants          | oui   |
| rappel (job)                                | `MATCH_REMINDER`                     | participants          | oui   |
| _(étape 9)_                                 | `VENUE_APPROVED` / `VENUE_SUSPENDED` | gérants               | oui   |

Règles :

- **Une notification ne fait jamais échouer l'action qui l'a provoquée** : erreurs journalisées, jamais propagées. L'email part
  en arrière-plan (un SMTP lent ne ralentit pas la requête).
- Aucun email ni téléphone d'un autre compte dans une notification : seulement des identifiants et des libellés d'affichage.
- Pas d'email tant que l'adresse n'est pas vérifiée ; un compte peut le désactiver (`preferences.emailNotifications = false`) :
  la notification reste dans l'application. Comptes bloqués ou supprimés : rien.
- `GET /me/notifications` renvoie `title` / `body` déjà traduits (utile au mobile) **et** `type` + `data` (le web peut retraduire).
  `unread-count`, `read`, `read-all`. Chacun ne voit que les siennes (404 sinon).
- Ménage : notifications lues depuis plus de 90 jours et toutes celles de plus d'un an sont supprimées.

### Rappels de match (`RemindersService`, toutes les minutes, verrou 727003)

Un rappel par match dans les 24 h qui précèdent, sauf si le match vient d'être créé (moins d'une heure) ou si sa réservation n'est
plus confirmée. Le match est « revendiqué » par un `UPDATE … reminderSentAt IS NULL` **avant** l'envoi ; un index unique en base
interdit en plus deux rappels du même match au même joueur.

## Emails (SMTP)

`MAIL_DRIVER=smtp` (nodemailer) : `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (TLS implicite), `SMTP_USER` / `SMTP_PASSWORD`, `MAIL_FROM`.
En production le démarrage échoue si le driver est `console`, si `SMTP_HOST` est local, si les identifiants sont incomplets, ou si
`API_PUBLIC_URL` manque ; STARTTLS est exigé quand la connexion n'est pas déjà chiffrée. Les sujets et destinataires sont
nettoyés des retours à la ligne (pas d'injection d'en-têtes). Non testé contre un vrai serveur SMTP (seul le transport est simulé).

## Avis

- `POST /bookings/:id/review` : client de la réservation, réservation **COMPLETED**, dans les 30 jours, **un seul** avis (note 1-5,
  commentaire ≤ 1000 caractères en texte brut). `GET /bookings/:id/review` : mon avis. `GET /venues/:slug/reviews` : public, paginé.
- La note du complexe (`ratingAvg`, `ratingCount`) est recalculée dans la transaction, **sous verrou du complexe** : 8 avis
  simultanés sont tous comptés. `recomputeVenueRating` / `lockVenueForRating` sont réutilisés par la modération (masquer un avis).
- L'auteur est affiché « Prénom N. » ; un compte supprimé devient « Utilisateur supprimé ».

## Images (avatar, logo d'équipe, photos de complexe)

- Corps **binaire** (`Content-Type: image/jpeg|png|webp`), 2 Mo maximum (le plafond JSON de 100 Ko des autres routes est inchangé).
- Le format réel est lu sur les **octets** et doit correspondre à l'en-tête ; SVG, GIF, HTML… refusés. Structure JPEG/PNG vérifiée,
  **métadonnées retirées** (EXIF/GPS, XMP, commentaires, blocs texte PNG). Limite : EXIF/XMP d'un WebP conservés.
- Les droits sont vérifiés **avant** d'accepter le moindre octet (capitaine pour le logo, gérant pour les photos : 10 maximum, sous verrou).
- Noms générés par le serveur (UUID) : rien de ce que choisit le client n'atteint le système de fichiers. `GET /uploads/:key` est public,
  mis en cache sans limite (le contenu ne change jamais) avec `nosniff`, une CSP `default-src 'none'; sandbox` et `Cross-Origin-Resource-Policy: cross-origin`.
- Stockage : `FileStorage` (contrat) + disque local (`STORAGE_LOCAL_DIR`). `STORAGE_DRIVER=s3` **refuse de démarrer** tant que
  l'adaptateur S3/MinIO n'est pas écrit : le disque local convient à une seule instance.
