import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const validDev = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  JWT_ACCESS_SECRET: 'dev-only-access-secret-change-me-0123456789',
  PAYMENT_PROVIDER: 'fake',
  PAYMENT_WEBHOOK_SECRET: 'dev-only-webhook-secret-change-me',
};

const validProd = {
  ...validDev,
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'k3J9xQ2mZp7LwR4vB8nT1yH6cD5fG0sA9uE2oI7',
  PAYMENT_PROVIDER: 'live',
  MAIL_DRIVER: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  API_PUBLIC_URL: 'https://api.footfive.example',
  PAYMENT_WEBHOOK_SECRET: 'wh_9d8f7a6b5c4e3d2c1b0a9f8e7d6c5b4a',
};

describe('loadEnv', () => {
  it('accepte une configuration de développement valide et applique les valeurs par défaut', () => {
    const env = loadEnv(validDev);
    expect(env.API_PORT).toBe(3000);
    expect(env.BOOKING_HOLD_MINUTES).toBe(10);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.STORAGE_DRIVER).toBe('local');
  });

  it('convertit les nombres fournis sous forme de chaînes', () => {
    const env = loadEnv({ ...validDev, API_PORT: '4000', BOOKING_HOLD_MINUTES: '15' });
    expect(env.API_PORT).toBe(4000);
    expect(env.BOOKING_HOLD_MINUTES).toBe(15);
  });

  it('refuse un secret JWT trop court', () => {
    expect(() => loadEnv({ ...validDev, JWT_ACCESS_SECRET: 'court' })).toThrow(EnvValidationError);
  });

  it('refuse une configuration sans DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validDev;
    expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('exige les paramètres S3 quand STORAGE_DRIVER=s3', () => {
    expect(() => loadEnv({ ...validDev, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  describe('garde-fous de production', () => {
    it('accepte une configuration de production correcte', () => {
      expect(loadEnv(validProd).NODE_ENV).toBe('production');
    });

    it('INTERDIT le fournisseur de paiement simulé en production', () => {
      expect(() => loadEnv({ ...validProd, PAYMENT_PROVIDER: 'fake' })).toThrow(
        /paiement simulé est interdit/,
      );
    });

    it('INTERDIT le driver d’email « console » en production (il journalise les liens secrets)', () => {
      expect(() => loadEnv({ ...validProd, MAIL_DRIVER: 'console' })).toThrow(/MAIL_DRIVER/);
    });

    it('exige l’adresse publique de l’API en production', () => {
      const { API_PUBLIC_URL: _omitted, ...withoutUrl } = validProd;
      expect(() => loadEnv(withoutUrl)).toThrow(/API_PUBLIC_URL/);
    });

    it('INTERDIT un serveur SMTP local, et des identifiants SMTP incomplets, en production', () => {
      expect(() => loadEnv({ ...validProd, SMTP_HOST: 'localhost' })).toThrow(/SMTP_HOST/);
      expect(() => loadEnv({ ...validProd, SMTP_USER: 'mailer' })).toThrow(/SMTP_PASSWORD/);
      expect(loadEnv({ ...validProd, SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret', SMTP_SECURE: 'true' }).SMTP_SECURE).toBe(true);
    });

    it('INTERDIT les secrets de développement en production', () => {
      expect(() =>
        loadEnv({ ...validProd, JWT_ACCESS_SECRET: validDev.JWT_ACCESS_SECRET }),
      ).toThrow(/JWT_ACCESS_SECRET/);
      expect(() =>
        loadEnv({ ...validProd, PAYMENT_WEBHOOK_SECRET: validDev.PAYMENT_WEBHOOK_SECRET }),
      ).toThrow(/PAYMENT_WEBHOOK_SECRET/);
    });
  });
});
