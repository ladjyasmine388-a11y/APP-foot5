-- ============================================================================
-- Foot Five — préparation d'un PostgreSQL local (installé sur la machine, sans Docker)
--
-- À exécuter UNE FOIS, en tant que superutilisateur, depuis la racine du projet :
--
--   "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -f scripts/db/setup-local.sql
--
-- Le script est idempotent : on peut le relancer sans risque (il ne supprime rien).
-- Il ne touche à aucune base existante autre que `footfive` et `footfive_test`.
--
-- Le mot de passe ci-dessous est un mot de passe de DÉVELOPPEMENT, identique à .env.example.
-- ============================================================================

-- Rôle applicatif (jamais superutilisateur). CREATEDB est requis par `prisma migrate dev`
-- (création de la base fantôme) et par les tests d'intégration.
SELECT 'CREATE ROLE footfive LOGIN CREATEDB PASSWORD ''footfive_dev_password'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'footfive')
\gexec

-- Bases en UTF-8 (indispensable pour l'arabe) avec tri ICU (insensible aux particularités de la locale Windows).
SELECT 'CREATE DATABASE footfive OWNER footfive ENCODING ''UTF8'' LOCALE_PROVIDER icu ICU_LOCALE ''und'' LOCALE ''C'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'footfive')
\gexec

SELECT 'CREATE DATABASE footfive_test OWNER footfive ENCODING ''UTF8'' LOCALE_PROVIDER icu ICU_LOCALE ''und'' LOCALE ''C'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'footfive_test')
\gexec

-- Extensions : btree_gist (contrainte anti-double-réservation), citext (emails), pgcrypto (UUID).
\connect footfive
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\connect footfive_test
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\echo
\echo '=== Foot Five : bases prêtes (footfive, footfive_test) ==='
