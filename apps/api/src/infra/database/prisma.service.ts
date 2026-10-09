import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { createPgAdapter } from './pg-adapter.js';

/**
 * Accès unique à PostgreSQL pour toute l'API.
 * La connexion est ouverte à la première requête (pas au démarrage) : l'API démarre
 * même si la base est momentanément indisponible, et /health/ready le signale.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: createPgAdapter(env.DATABASE_URL) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
