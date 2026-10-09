import { describe, expect, it } from 'vitest';
import {
  FALLBACK_CANCELLATION_POLICY,
  decideRefund,
  freeCancellationDeadline,
  parseCancellationPolicy,
} from './cancellation.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const inHours = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);
const policy = { freeUntilHoursBefore: 24, refundDeposit: false };

describe('decideRefund', () => {
  it('annulation gratuite (≥ 24 h avant) : remboursement intégral de ce qui a été payé', () => {
    expect(
      decideRefund({
        paidOnlineMinor: 800,
        startsAt: inHours(48),
        now: NOW,
        policy,
        initiator: 'PLAYER',
      }),
    ).toEqual({
      eligible: true,
      amountMinor: 800,
    });
  });

  it('pile à la limite (exactement 24 h avant) : encore gratuit', () => {
    expect(
      decideRefund({
        paidOnlineMinor: 800,
        startsAt: inHours(24),
        now: NOW,
        policy,
        initiator: 'PLAYER',
      }).eligible,
    ).toBe(true);
  });

  it('une minute après la limite : l’acompte reste acquis', () => {
    const startsAt = new Date(inHours(24).getTime() - 60_000);
    expect(
      decideRefund({ paidOnlineMinor: 800, startsAt, now: NOW, policy, initiator: 'PLAYER' }),
    ).toEqual({
      eligible: false,
      amountMinor: 0,
    });
  });

  it('annulation tardive mais le complexe rembourse l’acompte (refundDeposit)', () => {
    const lenient = { freeUntilHoursBefore: 24, refundDeposit: true };
    expect(
      decideRefund({
        paidOnlineMinor: 800,
        startsAt: inHours(2),
        now: NOW,
        policy: lenient,
        initiator: 'PLAYER',
      }).amountMinor,
    ).toBe(800);
  });

  it('rien n’a été payé : rien à rembourser', () => {
    expect(
      decideRefund({
        paidOnlineMinor: 0,
        startsAt: inHours(48),
        now: NOW,
        policy,
        initiator: 'PLAYER',
      }),
    ).toEqual({
      eligible: false,
      amountMinor: 0,
    });
  });

  it('annulation par le COMPLEXE : toujours remboursé intégralement, même à la dernière minute', () => {
    expect(
      decideRefund({
        paidOnlineMinor: 800,
        startsAt: inHours(1),
        now: NOW,
        policy,
        initiator: 'VENUE',
      }),
    ).toEqual({
      eligible: true,
      amountMinor: 800,
    });
  });

  it('délai gratuit nul : toujours remboursable jusqu’au début', () => {
    const none = { freeUntilHoursBefore: 0, refundDeposit: false };
    expect(
      decideRefund({
        paidOnlineMinor: 500,
        startsAt: inHours(0.5),
        now: NOW,
        policy: none,
        initiator: 'PLAYER',
      }).eligible,
    ).toBe(true);
  });
});

describe('freeCancellationDeadline', () => {
  it('= début − délai gratuit', () => {
    expect(freeCancellationDeadline(inHours(48), policy).toISOString()).toBe(
      inHours(24).toISOString(),
    );
  });
});

describe('parseCancellationPolicy', () => {
  it('accepte une politique valide, refuse le reste (retombe sur null)', () => {
    expect(parseCancellationPolicy({ freeUntilHoursBefore: 12, refundDeposit: true })).toEqual({
      freeUntilHoursBefore: 12,
      refundDeposit: true,
    });
    for (const bad of [
      null,
      undefined,
      {},
      'x',
      { freeUntilHoursBefore: -1, refundDeposit: true },
      { freeUntilHoursBefore: 1 },
    ]) {
      expect(parseCancellationPolicy(bad)).toBeNull();
    }
  });

  it('la politique de secours est de 24 h, sans remboursement tardif', () => {
    expect(FALLBACK_CANCELLATION_POLICY).toEqual({
      freeUntilHoursBefore: 24,
      refundDeposit: false,
    });
  });
});
