import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  buildUrl,
  getAccessToken,
  setAccessToken,
  setSessionLostHandler,
} from './api';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const errorBody = (code: string) => ({ error: { code, message: 'x', requestId: 'req-1' } });
const authResponse = (token: string) => ({
  accessToken: token,
  tokenType: 'Bearer',
  expiresIn: 900,
  user: { id: 'u1' },
});

describe('client HTTP', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken(null);
    setSessionLostHandler(null);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('construit l’adresse avec les paramètres utiles et ignore les vides', () => {
    expect(
      buildUrl('/venues', { city: 'Oran', q: '', page: undefined, n: 0, ok: false, none: null }),
    ).toBe('/api/v1/venues?city=Oran&n=0&ok=false');
    expect(buildUrl('/me')).toBe('/api/v1/me');
  });

  it('envoie le jeton, du JSON et la clé d’idempotence', async () => {
    setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api('/bookings', { method: 'POST', body: { a: 1 }, idempotencyKey: 'key-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/bookings');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      'idempotency-key': 'key-1',
    });
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe('include');
  });

  it('une route publique n’envoie jamais le jeton', async () => {
    setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(json(200, []));
    await api('/venues', { auth: false });
    expect(
      (fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['authorization'],
    ).toBeUndefined();
  });

  it('envoie une image telle quelle avec son type MIME', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { url: 'u' }));
    const blob = new Blob(['x'], { type: 'image/png' });
    await api('/me/avatar', { method: 'PUT', binary: { data: blob, contentType: 'image/png' } });
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/png');
    expect(init.body).toBe(blob);
  });

  it('renouvelle la session une fois sur jeton expiré, puis rejoue la requête avec le nouveau jeton', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(401, errorBody('TOKEN_EXPIRED')))
      .mockResolvedValueOnce(json(200, authResponse('new'))) // POST /auth/refresh
      .mockResolvedValueOnce(json(200, { items: [1] }));
    await expect(api('/bookings')).resolves.toEqual({ items: [1] });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/auth/refresh');
    expect((fetchMock.mock.calls[2]![1]!.headers as Record<string, string>)['authorization']).toBe(
      'Bearer new',
    );
    expect(getAccessToken()).toBe('new');
  });

  it('plusieurs requêtes expirées en même temps ne déclenchent qu’UN renouvellement', async () => {
    setAccessToken('old');
    let refreshes = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshes += 1;
        return Promise.resolve(json(200, authResponse('new')));
      }
      const headers = (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<
        string,
        string
      >;
      return Promise.resolve(
        headers['authorization'] === 'Bearer new'
          ? json(200, { ok: url })
          : json(401, errorBody('TOKEN_EXPIRED')),
      );
    });
    const results = await Promise.all([api('/a'), api('/b'), api('/c')]);
    expect(results).toHaveLength(3);
    expect(refreshes).toBe(1);
  });

  it('si le renouvellement échoue : la déconnexion est signalée et l’erreur remonte', async () => {
    setAccessToken('old');
    const lost = vi.fn();
    setSessionLostHandler(lost);
    fetchMock
      .mockResolvedValueOnce(json(401, errorBody('TOKEN_EXPIRED')))
      .mockResolvedValueOnce(json(401, errorBody('TOKEN_INVALID')));
    await expect(api('/bookings')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(lost).toHaveBeenCalledOnce();
    expect(getAccessToken()).toBeNull();
  });

  it('ne tente pas de renouvellement sur un refus métier (403, 409…) ni sur de mauvais identifiants', async () => {
    fetchMock.mockResolvedValueOnce(json(401, errorBody('INVALID_CREDENTIALS')));
    await expect(
      api('/auth/login', { method: 'POST', body: {}, auth: false }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    fetchMock.mockResolvedValueOnce(json(409, errorBody('SLOT_UNAVAILABLE')));
    await expect(api('/bookings', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      status: 409,
      requestId: 'req-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('traduit une panne réseau et une réponse sans corps JSON en erreurs exploitables', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/venues', { auth: false })).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    });
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const error = await api('/venues', { auth: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'UNKNOWN', status: 502 });
  });

  it('une réponse 204 ne renvoie rien', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api('/me/avatar', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
