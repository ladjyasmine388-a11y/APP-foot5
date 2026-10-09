# Authentification et sécurité des comptes

## Vue d'ensemble

| Élément                 | Choix                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Mots de passe           | **Argon2id** (19 Mio, 2 itérations, 1 thread — minimum OWASP), jamais stockés en clair                                 |
| Jeton d'accès           | JWT HS256, **15 min**, contient seulement `sub` (utilisateur) et `sid` (session)                                       |
| Jeton de renouvellement | Opaque (256 bits), **30 jours**, **rotation à chaque usage**, stocké sous forme d'empreinte SHA-256                    |
| Web                     | Refresh token dans un **cookie httpOnly** (`ff_refresh`, `SameSite=Lax`, chemin `/api/v1/auth`)                        |
| Mobile                  | Refresh token dans le corps de la réponse (en-tête `X-Client-Platform: mobile`), à stocker dans le Keychain / Keystore |
| Rôles                   | `User.platformRole` (`USER` \| `ADMIN`) + rôles **contextuels** (capitaine, staff de complexe)                         |

## Principes

**Privé par défaut.** Un garde global exige un jeton valide sur TOUTES les routes. On ouvre une route avec
`@Public()`, on la réserve avec `@Roles('ADMIN')`, on exige un email vérifié avec `@RequireVerifiedEmail()`.
Oublier un décorateur ne peut donc jamais exposer une route.

**Le jeton ne fait pas foi à lui seul.** À chaque requête, le garde relit en base la session et l'utilisateur :
déconnexion, vol de jeton, mot de passe changé, compte bloqué ou rôle retiré prennent effet **immédiatement**,
sans attendre l'expiration des 15 minutes. Coût : une requête indexée par appel authentifié.

**Pas d'assignation de masse.** Tous les schémas d'entrée sont `.strict()` : un champ inconnu
(`platformRole`, `emailVerifiedAt`…) est refusé, jamais ignoré. Le rôle, le statut et la vérification
ne proviennent jamais de la requête. Seul `toPublicUser()` fait sortir un utilisateur de l'API (liste blanche).

**Pas d'énumération des comptes.** Connexion : même message et même durée (empreinte factice) pour un email
inconnu ou un mauvais mot de passe. Mot de passe oublié : toujours `202`. Un compte suspendu n'est révélé
qu'avec le bon mot de passe.

## Sessions et refresh tokens

Une **session** = un appareil = une _famille_ de refresh tokens (`Session.familyId`). Le `sid` du JWT est le
`familyId` : il reste stable quand le refresh token tourne.

```
login            → crée la famille F, refresh token R1
refresh(R1)      → R1 révoqué ("rotated"), émet R2 (même famille F)
refresh(R1) < 10 s plus tard   → REFRESH_CONFLICT (deux onglets simultanés : on réessaie, rien n'est révoqué)
refresh(R1) > 10 s plus tard   → REFRESH_REUSED : TOUTE la famille F est révoquée + entrée d'audit
```

Réutiliser un jeton déjà remplacé signifie que quelqu'un d'autre le détient : on coupe la session entière.
La revendication d'un refresh token est **atomique** (`UPDATE … WHERE revokedAt IS NULL`) : deux requêtes
simultanées ne peuvent pas toutes les deux gagner.

## Protection CSRF

Seules les routes qui s'authentifient par **cookie** (`refresh`, `logout`) sont concernées. Elles exigent un en-tête
`Origin` exactement égal à `WEB_ORIGIN` (un site tiers ne peut pas le falsifier), en plus de `SameSite=Lax`.
Les routes qui utilisent `Authorization: Bearer` ne sont pas vulnérables au CSRF.

**Déploiement** : le web et l'API doivent partager le même domaine de premier niveau
(`app.exemple.dz` / `api.exemple.dz`) ou être servis sous la même origine par un reverse proxy,
sinon le navigateur n'enverra pas le cookie.

## Limitation de débit

| Route                            | Limite                                                |
| -------------------------------- | ----------------------------------------------------- |
| `POST /auth/login`               | 5 / 15 min par couple IP + email ; 40 / 15 min par IP |
| `POST /auth/register`            | 10 / h par IP                                         |
| `POST /auth/forgot-password`     | 3 / h par couple IP + email ; 10 / h par IP           |
| `POST /auth/reset-password`      | 10 / h par IP                                         |
| `POST /auth/verify-email`        | 20 / h par IP                                         |
| `POST /auth/resend-verification` | 3 / h par utilisateur                                 |
| `POST /auth/refresh`             | 60 / min par IP                                       |
| Global                           | `GLOBAL_RATE_LIMIT_PER_MINUTE` (300) par IP           |

La clé « IP + email » empêche un attaquant de **verrouiller le compte d'une victime** depuis une autre adresse.
Les compteurs sont **en mémoire** : valables pour une instance. Au passage à plusieurs instances, remplacer
`RateLimitStore` par une version Redis/PostgreSQL (même interface).

## Emails (vérification, réinitialisation)

Jetons à **usage unique**, valables 24 h (vérification) et 1 h (réinitialisation), stockés sous forme
d'empreinte. Un nouveau lien invalide le précédent. Gabarits en **arabe, français et anglais** selon la langue
du compte. En développement, le driver `console` affiche le lien dans les journaux ; il est **refusé au démarrage
en production** (`MAIL_DRIVER=smtp`, prévu à l'étape 8).

## Suppression de compte

`POST /me/delete-account` (mot de passe requis) **anonymise** : données personnelles effacées, email d'origine
libéré, sessions supprimées. La ligne est conservée pour la comptabilité des réservations passées.
Refusée tant qu'il reste une réservation ou une session à venir, ou une équipe à transférer.

## Évolutions prévues sans refonte

Google / Apple / téléphone (SMS) via `AuthIdentity` ; changement d'email avec vérification ; double authentification
pour les comptes admin ; limitation de débit partagée (Redis).
