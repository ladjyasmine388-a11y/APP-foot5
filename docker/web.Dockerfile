# syntax=docker/dockerfile:1
#
# Image du site web : fichiers statiques servis par nginx, qui relaie aussi /api vers l'API (une seule origine : pas de CORS).
#   docker build -f docker/web.Dockerfile -t footfive-web .
#
# ⚠ Non testée sur la machine de développement (Docker Desktop y est inutilisable) : à valider au premier déploiement.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.10.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
COPY e2e/package.json ./e2e/package.json
RUN pnpm install --frozen-lockfile --filter @footfive/web...
RUN pnpm --filter @footfive/shared build && pnpm --filter @footfive/web build

FROM nginx:1.31-alpine AS runtime
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
