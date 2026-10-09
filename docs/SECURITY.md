# Sécurité

Ce document décrit les contrôles **réellement en place**, ce qui reste à la charge de l'exploitant et les limites connues.
Il ne prétend pas qu'un audit externe a eu lieu : il n'y en a pas eu.

## Contrôles en place

### Comptes et sessions ([AUTH.md](AUTH.md))

- Mots de passe hachés en **Argon2id** ; politique de mot de passe imposée côté serveur.
- Jeton d'accès JWT court (15 min), gardé **en mémoire** côté web ; jeton de rafraîchissement dans un cookie `httpOnly`,
  `SameSite`, limité au chemin `/api/v1/auth`, `Secure` en production.
- Rotation des jetons de rafraîchissement avec **détection de réutilisation** (une réutilisation révoque la famille).
- Connexion limitée à 5 tentatives / 15 min par couple IP + email ; messages d'erreur identiques que le compte existe ou non.
- Email vérifié obligatoire pour réserver, rejoindre ou créer.
- Redirections après connexion filtrées (`safeNext`) : pas de redirection ouverte.

### Autorisation et isolation

- Rôles `PLAYER`, `VENUE_OWNER`, `VENUE_STAFF`, `ADMIN` ; gardes déclaratives sur chaque contrôleur.
- **Multi-tenant** : un gérant ou membre du personnel n'atteint que ses complexes ; les clés étrangères composites empêchent de
  rattacher une réservation au terrain d'un autre complexe. Les tests d'intégration vérifient les refus entre complexes.
- Toute action sensible (modération, remboursement, changement de commission, promotion d'administrateur) est écrite dans un
  **journal d'audit immuable** (trigger PostgreSQL : ni modification ni suppression).

### Argent

- Montants en entiers, **calculés uniquement côté serveur** ; le client n'envoie ni prix, ni commission, ni acompte.
- Webhooks de paiement **signés** (HMAC, comparaison en temps constant), idempotents, avec protection contre le rejeu.
- Une redirection du navigateur n'est jamais une preuve de paiement.
- Clés d'idempotence sur la création de réservation et de remboursement ; transitions d'état conditionnelles (`WHERE état = …`).
- Le prestataire `fake` et `live` (non écrit) **empêchent le démarrage en production**.

### Entrées, fichiers, réseau

- Toutes les entrées validées par des schémas **Zod** (partagés avec le client) ; requêtes SQL brutes paramétrées.
- Images : taille limitée (2 Mo), type vérifié par **signature binaire** (pas par extension), métadonnées EXIF/PNG retirées,
  noms générés côté serveur.
- `helmet` sur l'API, CSP stricte et en-têtes de sécurité dans nginx ; la page de paiement simulé a sa propre CSP.
- CORS restreint à `WEB_ORIGIN` ; limite de débit globale par IP en plus des limites ciblées (connexion, inscription, …).
- Documentation interactive `/api/docs` désactivée en production par défaut.
- Conteneur API : base PostgreSQL non publiée, secrets lus depuis l'environnement, jamais dans l'image.

### Chaîne d'approvisionnement

- `pnpm audit --prod --audit-level=high` s'exécute dans la CI à chaque poussée ; Dependabot ouvre des demandes hebdomadaires.
- Au moment de la livraison : **aucune vulnérabilité connue** (`pnpm audit`, dépendances de production et de développement).
  Trois avis touchant des dépendances de développement transitives (esbuild, mysql2, deepmerge-ts) sont corrigés par des
  `overrides` dans `pnpm-workspace.yaml` ; à retirer quand les paquets amont publieront les versions corrigées.

## Liste de contrôle avant mise en production

À cocher par l'exploitant — rien de ceci n'est fait par le code :

- [ ] Adaptateur de paiement CIB/Edahabia écrit, **testé en bac à sable du prestataire**, secret de webhook reçu et stocké.
- [ ] Secrets uniques et aléatoires : `JWT_ACCESS_SECRET`, `POSTGRES_PASSWORD`, `PAYMENT_WEBHOOK_SECRET`, identifiants SMTP.
- [ ] HTTPS valide devant l'application, HSTS activé, cookies `Secure` vérifiés dans le navigateur.
- [ ] `MAIL_DRIVER=smtp` avec SPF/DKIM/DMARC configurés sur le domaine d'envoi (sinon les emails de vérification finissent en spam).
- [ ] Aucun compte de démonstration : base **vierge**, jamais `db:seed:demo`. Premier administrateur via `db:create-admin`.
- [ ] Sauvegardes automatiques de la base et du volume d'images, **restauration testée**.
- [ ] Pare-feu : seuls 80/443 ouverts ; PostgreSQL inaccessible depuis Internet.
- [ ] Journaux centralisés et alerte sur erreurs 5xx et échecs de webhook.
- [ ] Mentions légales, conditions de réservation/annulation et politique de confidentialité rédigées (voir limites juridiques).
- [ ] Revue de la fiscalité de la commission et des frais avec un comptable algérien (taux, TVA, facturation).
- [ ] Test d'intrusion ou revue externe avant l'ouverture au public.

## Limites connues (à connaître, pas à cacher)

- **Limites de débit en mémoire** : valables pour une instance ; derrière plusieurs instances elles s'additionnent. Utiliser Redis
  avant de monter en charge ([ROADMAP.md](ROADMAP.md)).
- **Confiance dans `X-Forwarded-For`** : la configuration nginx fournie écrase l'en-tête ; avec un autre relais, il faut le faire
  nettoyer sinon un client peut falsifier son IP.
- **Stockage local des images** : une instance, pas de CDN, pas d'analyse antivirus. Les images WebP ne sont pas nettoyées de leurs
  métadonnées (JPEG et PNG le sont).
- **Pas d'authentification à deux facteurs** ni de verrouillage de compte au-delà de la limite de débit.
- **Pas de CAPTCHA** à l'inscription : un robot peut créer des comptes dans la limite du débit autorisé.
- **Données personnelles** : pas d'export ni d'effacement en libre-service pour l'utilisateur ; à prévoir selon la loi algérienne
  sur la protection des données (loi 18-07).
- Les fichiers Docker de production n'ont **pas été exécutés** ; la CI GitHub n'a pas été observée après ces changements.
- Aucun audit de sécurité externe n'a été réalisé.

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Contacter le responsable du projet en privé en décrivant la reproduction ; corriger puis
documenter dans le journal des modifications.
