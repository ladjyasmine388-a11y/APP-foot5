import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';

const CACHE_TTL_MS = 30_000;

/**
 * Paramètres globaux de la plateforme (table `PlatformSetting`), modifiables par l'admin sans redéploiement.
 * Petit cache de 30 s : ces valeurs sont lues à chaque calcul de disponibilité. Désactivé en test.
 */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly cacheEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.cacheEnabled = env.NODE_ENV !== 'test';
  }

  /** Valeur numérique entière d'un paramètre ; `fallback` si absent ou invalide (jamais d'exception). */
  async getInt(key: string, fallback: number): Promise<number> {
    const raw = await this.getRaw(key);
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  }

  /** Valeur JSON brute d'un paramètre (à valider par l'appelant), ou null si absent. */
  getJson(key: string): Promise<unknown> {
    return this.getRaw(key);
  }

  /** À appeler après une modification par l'admin. */
  invalidate(): void {
    this.cache.clear();
  }

  private async getRaw(key: string): Promise<unknown> {
    const now = Date.now();
    const cached = this.cacheEnabled ? this.cache.get(key) : undefined;
    if (cached && cached.expiresAt > now) return cached.value;

    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    const value = row?.value ?? null;
    if (this.cacheEnabled) this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }
}
