import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { NEST_APP_OPTIONS, configureApp, createAdapter } from './app.setup.js';
import { loadEnv } from './infra/config/env.js';
import { seedBaseline } from './infra/database/baseline.js';
import { PrismaService } from './infra/database/prisma.service.js';

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

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(),
    NEST_APP_OPTIONS,
  );
  await configureApp(app, env);

  // Paramètres indispensables (commission globale, durée du verrou…) : créés s'ils manquent, JAMAIS écrasés. Sans eux, aucune
  // réservation ne serait possible sur une base neuve. Une base momentanément indisponible ne bloque pas le démarrage
  // (/health/ready le signale) ; la prochaine mise en route complétera.
  try {
    await seedBaseline(app.get(PrismaService));
  } catch (error) {
    new Logger('Bootstrap').warn(
      `Paramètres de base non vérifiés : ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API démarrée sur le port ${env.API_PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
