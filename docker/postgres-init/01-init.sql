-- Exécuté uniquement à la première création du volume Postgres.

-- Base dédiée aux tests d'intégration (vraie base : la concurrence ne se teste pas avec des mocks).
CREATE DATABASE footfive_test;

-- Extensions nécessaires à la contrainte anti-double-réservation (EXCLUDE USING gist) et aux emails insensibles à la casse.
\connect footfive
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect footfive_test
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
