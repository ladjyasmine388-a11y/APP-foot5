import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitStore } from './rate-limit.store.js';

describe('RateLimitStore', () => {
  const stores: RateLimitStore[] = [];
  const make = () => {
    const store = new RateLimitStore();
    stores.push(store);
    return store;
  };
  afterEach(() => {
    for (const store of stores.splice(0)) store.onModuleDestroy();
  });

  it('autorise jusqu’à la limite puis refuse', () => {
    const store = make();
    const results = Array.from({ length: 5 }, () => store.hit('k', 3, 60, 1_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[0]?.remaining).toBe(2);
    expect(results[2]?.remaining).toBe(0);
  });

  it('indique le délai avant de pouvoir réessayer', () => {
    const store = make();
    store.hit('k', 1, 60, 0);
    const blocked = store.hit('k', 1, 60, 20_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(40);
  });

  it('repart de zéro à la fin de la fenêtre', () => {
    const store = make();
    store.hit('k', 1, 60, 0);
    expect(store.hit('k', 1, 60, 30_000).allowed).toBe(false);
    expect(store.hit('k', 1, 60, 61_000).allowed).toBe(true);
  });

  it('isole les clés les unes des autres', () => {
    const store = make();
    store.hit('a', 1, 60, 0);
    expect(store.hit('a', 1, 60, 1).allowed).toBe(false);
    expect(store.hit('b', 1, 60, 1).allowed).toBe(true);
  });

  it('reset() remet tous les compteurs à zéro', () => {
    const store = make();
    store.hit('a', 1, 60, 0);
    store.reset();
    expect(store.hit('a', 1, 60, 1).allowed).toBe(true);
  });
});
