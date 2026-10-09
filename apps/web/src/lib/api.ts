import type { ApiErrorBody, AuthResponse, ErrorCode } from '@footfive/shared';

/**
 * Client HTTP unique de l'application. Le jeton d'accès reste EN MÉMOIRE (jamais dans localStorage : un script
 * injecté ne peut pas le lire) ; la session est renouvelée par le cookie de rafraîchissement httpOnly.
 */
const BASE =
  (import.meta.env['VITE_API_URL'] as string | undefined)?.replace(/\/+$/, '') ?? '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK' | 'UNKNOWN',
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<AuthResponse | null> | null = null;
let onSessionLost: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;
/** Appelé quand la session ne peut plus être renouvelée (déconnexion forcée). */
export const setSessionLostHandler = (handler: (() => void) | null): void => {
  onSessionLost = handler;
};

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  /** `false` : route publique, aucun jeton envoyé ni renouvelé. */
  auth?: boolean;
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** Corps binaire (envoi d'image) : envoyé tel quel avec son type MIME. */
  binary?: { data: Blob; contentType: string };
}

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* réponse sans corps JSON */
  }
  const err = body?.error;
  return new ApiError(
    res.status,
    err?.code ?? 'UNKNOWN',
    err?.message ?? res.statusText,
    err?.details,
    err?.requestId,
  );
}

/** Renouvelle la session via le cookie httpOnly. Une seule requête de renouvellement à la fois, partagée. */
export function refreshSession(): Promise<AuthResponse | null> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const data = (await res.json()) as AuthResponse;
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

const RENEWABLE: ReadonlySet<string> = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'UNAUTHENTICATED',
]);

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (opts.binary) {
    headers['content-type'] = opts.binary.contentType;
    body = opts.binary.data;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.auth !== false && accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'Réseau indisponible');
  }
}

export async function api<T = void>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);
  if (res.status === 401 && opts.auth !== false) {
    const err = await toError(res.clone());
    if (RENEWABLE.has(err.code) && (await refreshSession())) {
      res = await send(path, opts); // une seule nouvelle tentative avec le jeton renouvelé
    } else if (RENEWABLE.has(err.code)) {
      onSessionLost?.();
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? await res.json() : undefined) as T;
}

/** Clé d'idempotence : à CONSERVER pendant toute la durée d'une même intention (réessai après erreur réseau = même clé). */
export const newIdempotencyKey = (): string => crypto.randomUUID();
