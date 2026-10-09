import { Injectable, type OnModuleDestroy } from '@nestjs/common';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Compteurs de limitation de débit en MÉMOIRE (fenêtre fixe).
 *
 * Limite assumée : ils ne sont pas partagés entre plusieurs instances de l'API. Pour le MVP (une instance)
 * c'est suffisant ; au passage à plusieurs instances, remplacer cette classe par une version Redis/PostgreSQL
 * sans toucher au reste (même interface : `hit` et `reset`).
 */
@Injectable()
export class RateLimitStore implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly cleaner = setInterval(() => this.purge(), 60_000);

  constructor() {
    this.cleaner.unref();
  }

  hit(key: string, limit: number, windowSeconds: number, now = Date.now()): RateLimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** Remet les compteurs à zéro (tests, ou déblocage manuel par un admin). */
  reset(): void {
    this.buckets.clear();
  }

  private purge(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleaner);
  }
}
