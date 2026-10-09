import { z } from 'zod';

const positiveInt = (def: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

/**
 * Schéma des variables d'environnement. L'application refuse de démarrer
 * si la configuration est invalide (fail fast), notamment en production.
 */
const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: positiveInt(3000, 1, 65535),
  WEB_ORIGIN: z.string().url(),
  /** Adresse publique de l'API (pages de paiement du prestataire simulé). Défaut : http://localhost:<API_PORT>. */
  API_PUBLIC_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET doit contenir au moins 32 caractères'),
  JWT_ACCESS_TTL_SECONDS: positiveInt(900, 60, 3600),
  REFRESH_TOKEN_TTL_DAYS: positiveInt(30, 1, 90),

  BOOKING_HOLD_MINUTES: positiveInt(10, 1, 60),

  /** `fake` = fournisseur simulé (dev/test uniquement). `live` = adaptateur réel (CIB/Edahabia). */
  PAYMENT_PROVIDER: z.enum(['fake', 'live']).default('fake'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),

  /** `console` : affiche les emails dans les journaux (dev/test uniquement). `smtp` : envoi réel. */
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: positiveInt(1025, 1, 65535),
  /** TLS implicite (port 465). Sinon STARTTLS est négocié ; il est EXIGÉ en production. */
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Foot Five <no-reply@footfive.local>'),

  /** Plafond global de requêtes par IP et par minute (filet de sécurité ; les routes sensibles ont leurs propres limites). */
  GLOBAL_RATE_LIMIT_PER_MINUTE: positiveInt(300, 10, 100_000),

  /** Documentation OpenAPI (/api/docs). Par défaut : activée sauf en production. */
  OPENAPI_ENABLED: z.stringbool().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
});

const envSchema = baseSchema.superRefine((env, ctx) => {
  const fail = (path: keyof typeof env, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });

  if (env.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
      if (!env[key]) fail(key, `${key} est requis quand STORAGE_DRIVER=s3`);
    }
  }

  if (env.NODE_ENV === 'production') {
    // Garde-fous : jamais de paiement simulé ni de secrets de développement en production.
    if (env.PAYMENT_PROVIDER === 'fake') {
      fail('PAYMENT_PROVIDER', 'Le fournisseur de paiement simulé est interdit en production');
    }
    // Le driver console écrit les liens de vérification / réinitialisation dans les journaux : jamais en production.
    if (!env.API_PUBLIC_URL) {
      fail('API_PUBLIC_URL', 'Requis en production (adresse publique des images envoyées)');
    }
    if (env.MAIL_DRIVER === 'console') {
      fail('MAIL_DRIVER', 'Le driver d’email « console » est interdit en production');
    }
    if (env.MAIL_DRIVER === 'smtp' && ['localhost', '127.0.0.1', '::1'].includes(env.SMTP_HOST)) {
      fail('SMTP_HOST', 'Un serveur SMTP local est interdit en production');
    }
    if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_USER !== !env.SMTP_PASSWORD) {
      fail('SMTP_PASSWORD', 'SMTP_USER et SMTP_PASSWORD vont ensemble');
    }
    if (env.JWT_ACCESS_SECRET.includes('dev-only') || env.JWT_ACCESS_SECRET.includes('test-only')) {
      fail('JWT_ACCESS_SECRET', 'Secret de développement interdit en production');
    }
    if (
      env.PAYMENT_WEBHOOK_SECRET.includes('dev-only') ||
      env.PAYMENT_WEBHOOK_SECRET.includes('test-only')
    ) {
      fail('PAYMENT_WEBHOOK_SECRET', 'Secret de développement interdit en production');
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration invalide :\n - ${issues.join('\n - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}
