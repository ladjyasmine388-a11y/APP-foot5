import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './app.setup.js';
import { loadEnv } from './infra/config/env.js';

// En développement, charge le .env de la racine du dépôt. Jamais en production : la configuration
// vient alors de l'environnement du serveur (un fichier .env en production serait un risque).
if (process.env['NODE_ENV'] !== 'production') {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    /* pas de .env : on s'appuie sur l'environnement */
  }
}

async function bootstrap(): Promise<void> {
  // Valide la configuration AVANT toute initialisation : on échoue vite et clairement.
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter());
  await configureApp(app, env);

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API démarrée sur le port ${env.API_PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
