import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';
import { SignJWT } from 'jose';
import { AppModule } from '../../src/app.module.js';
import { configureApp, createAdapter } from '../../src/app.setup.js';
import { loadEnv } from '../../src/infra/config/env.js';
import { Mailer, type MailMessage } from '../../src/infra/mail/mailer.js';
import { RateLimitStore } from '../../src/modules/auth/rate-limit/rate-limit.store.js';

/** Faux serveur d'email : capture les messages au lieu de les envoyer. */
export class CapturingMailer extends Mailer {
  sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  to(email: string): MailMessage[] {
    return this.sent.filter((m) => m.to === email);
  }

  /** Extrait le jeton secret du lien contenu dans le dernier email envoyé à cette adresse. */
  lastToken(email: string): string {
    const last = this.to(email).at(-1);
    const match = last?.text.match(/[?&]token=([\w-]+)/);
    if (!match?.[1]) throw new Error(`Aucun lien avec jeton dans les emails envoyés à ${email}`);
    return match[1];
  }

  reset(): void {
    this.sent = [];
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  mailer: CapturingMailer;
  rateLimits: RateLimitStore;
  close: () => Promise<void>;
}

export const WEB_ORIGIN = 'http://localhost:5173';

/** Lance l'application COMPLÈTE (mêmes plugins, gardes et filtres qu'en production) avec un faux serveur d'email. */
export async function createTestApp(extraControllers: Type[] = []): Promise<TestApp> {
  const mailer = new CapturingMailer();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(Mailer)
    .useValue(mailer)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app, loadEnv());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return { app, mailer, rateLimits: app.get(RateLimitStore), close: () => app.close() };
}

export const validRegistration = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Yasmine',
  lastName: 'Benali',
  email: `joueur-${randomUUID()}@example.com`,
  phone: '0550 12 34 56',
  password: 'un-bon-mot-de-passe',
  acceptTerms: true,
  ...overrides,
});

type Headers = Record<string, string>;

export function post(
  { app }: TestApp,
  url: string,
  payload?: unknown,
  headers: Headers = {},
  remoteAddress?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload: payload as object,
    headers,
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

export function get(
  { app }: TestApp,
  url: string,
  token?: string,
  headers: Headers = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

export function patch(
  { app }: TestApp,
  url: string,
  payload: unknown,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1${url}`,
    payload: payload as object,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export function del(
  { app }: TestApp,
  url: string,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });

export function refreshCookieOf(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === 'ff_refresh')?.value;
}

export interface Signup {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
  /** Refresh token (le client est déclaré « mobile » pour le recevoir dans le corps). */
  refreshToken: string;
}

/** Inscrit un utilisateur comme le ferait une application mobile (refresh token dans le corps). */
export async function signup(t: TestApp, overrides: Record<string, unknown> = {}): Promise<Signup> {
  const body = validRegistration(overrides);
  const res = await post(t, '/auth/register', body, { 'x-client-platform': 'mobile' });
  if (res.statusCode !== 201) throw new Error(`Inscription impossible : ${res.body}`);
  const json = res.json();
  return {
    email: body.email,
    password: body.password,
    userId: json.user.id,
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
  };
}

/** Fabrique un jeton d'accès signé avec le BON secret mais des revendications choisies (jeton expiré, session inconnue…). */
export async function craftAccessToken(opts: {
  userId: string;
  sessionId: string;
  expiresInSeconds?: number;
  secret?: string;
  issuer?: string;
  audience?: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(opts.secret ?? process.env['JWT_ACCESS_SECRET']);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: opts.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.userId)
    .setIssuer(opts.issuer ?? 'footfive-api')
    .setAudience(opts.audience ?? 'footfive-clients')
    .setIssuedAt(now - 3600)
    .setExpirationTime(now + (opts.expiresInSeconds ?? 600))
    .sign(secret);
}
