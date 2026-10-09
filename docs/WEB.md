# Application web (étape 10)

React 19 + Vite + TypeScript, Tailwind v4, TanStack Query, React Router. **Même API que le futur mobile** : aucune logique métier n'est
dupliquée côté navigateur (prix, commission, disponibilités, droits… sont toujours décidés par le serveur ; le web ne fait que valider
les formulaires avec les **mêmes schémas Zod** que l'API, importés de `@footfive/shared`).

## Lancer en développement

```bash
pnpm --filter @footfive/api db:seed:demo   # données de démonstration (refusé en production)
pnpm --filter @footfive/api dev            # API  → http://localhost:3000
pnpm --filter @footfive/web dev            # Web  → http://localhost:5173 (le proxy Vite relaie /api vers l'API)
```

Comptes de démonstration (le mot de passe commun est la constante `DEMO_PASSWORD` de [apps/api/prisma/seed-demo.ts](../apps/api/prisma/seed-demo.ts),
**réservé au développement**) : `admin@footfive.dz`, `gerant1@footfive.dz` … `gerant5@footfive.dz`, `joueur01@footfive.dz` … `joueur20@footfive.dz`.
Le paiement est **simulé** (`PAYMENT_PROVIDER=fake`) : la page de paiement porte le bandeau « SIMULATION — aucun argent réel ».

## Pages

| Zone | Routes |
|---|---|
| Public | `/` accueil + recherche · `/venues` · `/venues/:slug` (disponibilités, avis) · `/solo` · `/solo/:id` · `/opponents` · `/opponents/:id` |
| Compte | `/login` · `/register` · `/verify-email` · `/forgot-password` · `/reset-password` |
| Joueur | `/book/:fieldId` · `/bookings` · `/bookings/:id` · `/bookings/:id/payment` (retour de paiement) · `/teams` · `/teams/:id` · `/solo/new` · `/opponents/new` · `/matches` · `/matches/:id` · `/matches/new` · `/notifications` · `/profile` |
| Complexe | `/manage` · `/manage/venues/new` · `/manage/venues/:id/{bookings,fields,hours,info,staff,stats}` |
| Administration | `/admin` (tableau de bord) · `venues` · `users` · `commission` · `settings` · `refunds` · `reviews` · `audit` |

Les espaces **complexe** et **administration** sont chargés à la demande, comme chaque page (premier affichage ≈ 77 Ko compressés).

## Trois langues, dont l'arabe (RTL)

- Chaque texte est une clé avec **ses trois traductions côte à côte** (`src/i18n/messages/*.ts`) : en oublier une est une erreur de compilation.
  Un test vérifie en plus qu'aucune clé n'est dupliquée, que les variables `{…}` sont identiques dans les trois langues et que l'arabe contient bien de l'arabe.
- Chaque code d'erreur de l'API a son message traduit (`Record<ErrorCode, …>` : ajouter un code serveur casse la compilation du web tant qu'il n'est pas traduit).
- `<html lang dir>` suit la langue ; les styles utilisent les **propriétés logiques** (`ms-*`, `ps-*`, `text-start`, `end-*`) : la mise en page se retourne seule.
- Heures **toujours à l'heure d'Alger** ; chiffres occidentaux et espace comme séparateur de milliers (le point arabe se lirait comme une décimale).
- La langue choisie est mémorisée dans le navigateur et, si le joueur est connecté, dans son profil (emails et notifications suivent).

## Sécurité côté navigateur

- Le **jeton d'accès reste en mémoire** (jamais dans `localStorage`) ; la session se rouvre par le cookie de rafraîchissement `httpOnly`. Un seul renouvellement à la fois,
  même si dix requêtes expirent ensemble ; en cas d'échec, déconnexion propre et cache vidé (aucune donnée d'un compte ne survit à sa déconnexion).
- Redirection après connexion (`?next=`) : **uniquement un chemin interne** (`safeNext`), jamais une adresse externe.
- Aucun HTML injecté : commentaires, avis, noms… sont affichés comme du texte.
- Réservation et paiement : **clés d'idempotence conservées** pendant toute une intention (un réseau qui coupe puis un réessai ne crée jamais deux réservations).
  La page de retour de paiement n'apporte aucune preuve : elle interroge le serveur, qui interroge le prestataire.
- Envoi d'images : contrôle de type et de poids pour le confort ; le serveur revérifie le vrai format et retire les métadonnées (GPS).

## Accessibilité et mobile

- Mobile d'abord : barre de navigation basse (zones tactiles ≥ 44 px, zone sûre de l'écran), filtres repliables, formulaires lisibles sans zoom.
- Champs liés à leur libellé, à leur aide et à leur erreur (`aria-describedby`, `aria-invalid`) ; lien « Aller au contenu » ; fenêtres modales natives (`<dialog>`) ;
  histogrammes doublés d'un tableau pour les lecteurs d'écran ; `prefers-reduced-motion` respecté.

## Tests

`pnpm --filter @footfive/web test` : client HTTP (renouvellement, concurrence, erreurs), formulaires, redirection sûre, formats (montants, heures d'Alger, conversion de fuseau),
cohérence des traductions, composants (sens de lecture, accessibilité des champs, modale).

## Limites connues

- Pas encore de tests de bout en bout dans un navigateur (étape 11) ; les parcours principaux ont été vérifiés à la main dans un navigateur réel
  (connexion, réservation + paiement simulé, arabe/RTL, administration, espace complexe, mobile).
- Pas de carte (les coordonnées existent côté API) ni de PWA hors ligne.
