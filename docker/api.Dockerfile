# syntax=docker/dockerfile:1
#
# Image de l'API. Construire depuis la RACINE du dépôt :
#   docker build -f docker/api.Dockerfile -t footfive-api .
#
# ⚠ Non testée sur la machine de développement (Docker Desktop y est inutilisable) : à valider au premier déploiement.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.10.1
WORKDIR /app

# ── Construction : toutes les dépendances, génération du client Prisma, compilation ──
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# Les autres membres du workspace doivent exister pour que le fichier de verrouillage soit reconnu à jour.
COPY apps/web/package.json ./apps/web/package.json
COPY e2e/package.json ./e2e/package.json
RUN pnpm install --frozen-lockfile --filter @footfive/api...
RUN pnpm --filter @footfive/shared build \
 && pnpm --filter @footfive/api generate \
 && pnpm --filter @footfive/api build

# ── Exécution ──
# On garde ici les dépendances de développement : l'outil de migration (prisma) et le script d'administration (tsx)
# en ont besoin. L'image est plus lourde qu'un déploiement « prod seulement » ; c'est le prix d'un démarrage fiable.
FROM base AS runtime
ENV NODE_ENV=production API_PORT=3000
COPY --from=build /app /app
RUN mkdir -p /data/uploads && chown -R node:node /data /app/apps/api
USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Les migrations sont appliquées au démarrage (Prisma les sérialise : plusieurs instances ne se gênent pas).
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
