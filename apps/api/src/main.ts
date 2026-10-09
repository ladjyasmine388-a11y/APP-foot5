import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './app.setup.js';
import { loadEnv } from './infra/config/env.js';

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
