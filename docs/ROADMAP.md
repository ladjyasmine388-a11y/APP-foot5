# Feuille de route

Ce qui reste à faire après les 11 étapes, **par ordre d'importance pour un lancement réel**. Rien ici n'est caché dans le code :
ces points sont des manques assumés, pas des surprises.

## Bloquants pour la production

1. **Adaptateur de paiement CIB / Edahabia** (SATIM, directement ou via un agrégateur). Le contrat `PaymentProvider` est prêt
   (création, webhook signé, remboursement) ; il manque l'implémentation et le contrat commercial. Procédure :
   [PAYMENTS.md](PAYMENTS.md#brancher-cib--edahabia-ou-un-agrégateur). Tant qu'il n'existe pas, l'API refuse de démarrer en production.
2. **Cadre fiscal et juridique** à valider avec un comptable / juriste algérien : traitement de la commission de 1 %, TVA, facturation
   au joueur et au complexe, politique d'annulation par défaut (24 h gratuite, acompte 20 %), conditions générales, confidentialité
   (loi 18-07), mentions légales.
3. **Validation du déploiement Docker** sur un vrai serveur (les fichiers n'ont jamais été exécutés), TLS, sauvegardes testées.

## Avant une montée en charge

- **Redis** pour les limites de débit partagées entre instances et un éventuel cache de disponibilités.
- **Stockage S3 compatible** (adaptateur `STORAGE_DRIVER=s3`) + CDN pour les images ; sans cela, une seule instance d'API.
- **File de tâches** (rappels, emails) avec reprises, au lieu des tâches périodiques sous verrou consultatif.
- **Observabilité** : journaux structurés centralisés, métriques (latence, erreurs, réservations/minute), alertes sur échecs de webhook.
- Tests de charge sur la recherche de disponibilités et la création de réservations.

## Produit

- **Application mobile** (React Native / Expo) réutilisant l'API et `packages/shared` ; notifications push (FCM/APNs).
- **SMS** pour la vérification et les rappels (important en Algérie où l'email est peu consulté).
- **Carte** et recherche par proximité (aujourd'hui : filtres par wilaya/ville).
- **Photos des complexes** : les données de démonstration n'en ont pas ; prévoir un parcours d'import pour les gérants.
- **Paiement par le joueur de sa part** dans une session solo (aujourd'hui réglée hors plateforme, choix assumé).
- Tarification dynamique (heures creuses/pleines avancées), abonnements, tournois, classements.
- Facturation PDF et export comptable pour les gérants.
- Authentification à deux facteurs, CAPTCHA à l'inscription, export et effacement des données personnelles en libre-service.
- PWA hors ligne.

## Dette technique connue

- Retirer les `overrides` de `pnpm-workspace.yaml` quand esbuild, mysql2 et deepmerge-ts amont seront corrigés.
- Nettoyage des métadonnées des images WebP (JPEG et PNG le sont déjà).
- Observer la CI GitHub au premier passage et stabiliser tout test intermittent.
