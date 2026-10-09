# Déploiement

> **État honnête** : l'application est complète et testée en développement, mais **elle ne peut pas encore être lancée en production
> réelle**. L'API refuse volontairement de démarrer avec `NODE_ENV=production` tant que le paiement est `fake` (interdit) ou
> `live` (l'adaptateur CIB/Edahabia n'est pas écrit — voir [PAYMENTS.md](PAYMENTS.md#brancher-cib--edahabia-ou-un-agrégateur)).
> Les fichiers Docker de ce document n'ont **jamais été exécutés** (Docker Desktop est inutilisable sur la machine de
> développement) : traitez le premier déploiement comme une validation.

## Trois usages possibles

| Usage                         | `NODE_ENV`    | Paiement              | À savoir                                                                             |
| ----------------------------- | ------------- | --------------------- | ------------------------------------------------------------------------------------ |
| Développement local           | `development` | `fake`                | Voir le [README](../README.md)                                                       |
| Démonstration / préproduction | `development` | `fake`                | Données de démo, aucun vrai argent. **Ne jamais exposer à de vrais clients.**        |
| Production réelle             | `production`  | `live` (CIB/Edahabia) | Nécessite d'écrire l'adaptateur ([ROADMAP.md](ROADMAP.md)), puis la liste ci-dessous |

## Configuration (variables d'environnement)

Modèle complet commenté : [`.env.production.example`](../.env.production.example). Toute la configuration est validée au démarrage
(`apps/api/src/infra/config/env.ts`) ; une valeur dangereuse en production empêche le démarrage.

| Variable                                     | Rôle                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `WEB_ORIGIN`, `API_PUBLIC_URL`               | Adresse publique. Une seule origine en production (nginx relaie `/api`) : pas de CORS |
| `DATABASE_URL`                               | PostgreSQL 16, rôle **non superutilisateur** (voir `scripts/db/setup-local.sql`)      |
| `JWT_ACCESS_SECRET`                          | ≥ 32 caractères aléatoires, propre à l'environnement                                  |
| `PAYMENT_PROVIDER`, `PAYMENT_WEBHOOK_SECRET` | `fake` interdit en production ; secret de signature fourni par le prestataire         |
| `MAIL_DRIVER=smtp`, `SMTP_*`, `MAIL_FROM`    | Le pilote `console` est interdit en production                                        |
| `STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR`  | Disque local : **une seule instance** de l'API (l'adaptateur S3 n'existe pas encore)  |
| `BOOKING_HOLD_MINUTES`                       | Durée du verrou de paiement (10 min par défaut)                                       |
| `GLOBAL_RATE_LIMIT_PER_MINUTE`               | Limite globale par IP (300 par défaut)                                                |
| `OPENAPI_ENABLED`                            | `/api/docs` : désactivé en production par défaut                                      |

## Déploiement mono-serveur avec Docker (non testé)

```bash
cp .env.production.example .env.production   # remplir TOUTES les valeurs, ne jamais committer
docker compose -f docker/compose.prod.yml --env-file .env.production up -d --build
```

- `docker/api.Dockerfile` : construit l'API, applique les migrations (`prisma migrate deploy`) puis démarre.
- `docker/web.Dockerfile` + `docker/nginx/default.conf` : site statique + relais `/api` + en-têtes de sécurité.
- PostgreSQL n'est **jamais publié** : seul l'API l'atteint par le réseau interne.
- Volumes : `pgdata` (base) et `uploads` (images). **Les deux doivent être sauvegardés.**

### HTTPS

nginx écoute en HTTP. Terminez TLS devant (Caddy, Traefik, répartiteur de charge, ou nginx + certbot). Le cookie de session est
`Secure` en production : sans HTTPS, la connexion ne fonctionnera pas. Ajoutez `Strict-Transport-Security` côté HTTPS.
Si un autre relais précède nginx, lisez le commentaire sur `X-Forwarded-For` dans `default.conf` : l'adresse IP du client
alimente les limites de débit et le journal d'audit.

## Premier démarrage

1. **Migrations** : appliquées automatiquement par le conteneur API (`prisma migrate deploy`) ; à la main :
   `pnpm --filter @footfive/api db:deploy`.
2. **Données de base** : au démarrage, l'API crée la commission globale (1 %) et les paramètres par défaut si absents
   (idempotent). La commission se modifie ensuite depuis l'espace administrateur, avec historique.
3. **Premier administrateur** : créez un compte normalement (inscription + vérification d'email), puis :

   ```bash
   pnpm --filter @footfive/api db:create-admin -- vous@exemple.dz
   ```

   Le script promeut un compte **existant, actif et vérifié** et écrit l'action dans le journal d'audit. Il n'existe aucun compte
   administrateur par défaut en production.

4. **Données de démonstration** : `db:seed:demo` n'est destiné qu'au développement et à la démonstration ; il crée des comptes au
   mot de passe commun connu (constante `DEMO_PASSWORD` dans `apps/api/prisma/seed-demo.ts`). **Jamais en production.**

## Sauvegardes et restauration

- Base : `pg_dump -Fc` quotidien au minimum, copie hors du serveur, **test de restauration** régulier. Le journal d'audit est dans la
  base : le sauvegarder, c'est conserver la traçabilité financière.
- Images : sauvegarder le volume `uploads`.
- Les migrations sont appliquées en avant uniquement ; pour revenir en arrière, restaurez la sauvegarde d'avant la mise à jour.
  Faites donc toujours un dump **avant** `migrate deploy`.

## Mises à jour

1. Dump de la base. 2. `git pull`, reconstruction des images. 3. L'API applique les migrations au démarrage.
2. Vérifier `GET /api/v1/health` (et `/healthz` côté nginx). Les migrations sont écrites pour être rétrocompatibles avec une
   brève coexistence, mais l'API n'est prévue que pour **une instance** : prévoyez une courte interruption.

## Limites connues de l'exploitation

- **Une seule instance d'API** : les limites de débit sont en mémoire et le stockage d'images est local.
  Les tâches de fond sont déjà protégées par verrous consultatifs, mais cette configuration n'a pas été éprouvée à plusieurs instances.
- Pas de supervision intégrée (métriques, alertes) : brancher des sondes sur `/api/v1/health` et surveiller les journaux.
- Sauvegardes, rotation des secrets et TLS sont de la responsabilité de l'exploitant ; la liste de contrôle est dans
  [SECURITY.md](SECURITY.md#liste-de-contrôle-avant-mise-en-production).
