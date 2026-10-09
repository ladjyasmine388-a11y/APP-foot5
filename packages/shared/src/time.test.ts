import { describe, expect, it } from 'vitest';
import { formatTime, parseTime, rangesOverlap, toMinuteRange, toRangeView } from './time';

describe('parseTime / formatTime', () => {
  it.each([
    ['00:00', 0],
    ['09:05', 545],
    ['20:30', 1230],
    ['23:59', 1439],
  ])('%s ↔ %i', (text, minutes) => {
    expect(parseTime(text)).toBe(minutes);
    expect(formatTime(minutes)).toBe(text);
  });

  it.each(['24:00', '9:00', '12:60', 'abc', '', '12h30', '-1:00'])('refuse « %s »', (text) => {
    expect(parseTime(text)).toBeNull();
  });

  it('formatTime ramène les minutes du lendemain dans la journée', () => {
    expect(formatTime(1560)).toBe('02:00');
    expect(formatTime(1440)).toBe('00:00');
  });
});

describe('toMinuteRange', () => {
  it('plage dans la journée', () => {
    expect(toMinuteRange('10:00', '23:00')).toEqual({ startMin: 600, endMin: 1380 });
  });

  it('fermeture après minuit : « 10:00 → 02:00 » finit le lendemain', () => {
    expect(toMinuteRange('10:00', '02:00')).toEqual({ startMin: 600, endMin: 1560 });
  });

  it('« → 00:00 » signifie minuit', () => {
    expect(toMinuteRange('10:00', '00:00')).toEqual({ startMin: 600, endMin: 1440 });
  });

  it('refuse début = fin (24 h pleines : ambigu) et les fermetures au-delà de 06:00 le lendemain', () => {
    expect(toMinuteRange('10:00', '10:00')).toBeNull();
    expect(toMinuteRange('10:00', '07:00')).toBeNull();
    expect(toMinuteRange('10:00', '06:00')).toEqual({ startMin: 600, endMin: 1800 });
  });

  it('refuse les formats invalides', () => {
    expect(toMinuteRange('25:00', '02:00')).toBeNull();
    expect(toMinuteRange('10:00', 'x')).toBeNull();
  });

  it('toRangeView signale le lendemain', () => {
    expect(toRangeView({ startMin: 600, endMin: 1560 })).toEqual({
      from: '10:00',
      to: '02:00',
      overnight: true,
    });
    expect(toRangeView({ startMin: 600, endMin: 1380 })).toEqual({
      from: '10:00',
      to: '23:00',
      overnight: false,
    });
  });
});

describe('rangesOverlap', () => {
  it('les plages sont semi-ouvertes : bout à bout ne se chevauchent pas', () => {
    expect(rangesOverlap({ startMin: 600, endMin: 720 }, { startMin: 720, endMin: 800 })).toBe(
      false,
    );
    expect(rangesOverlap({ startMin: 600, endMin: 721 }, { startMin: 720, endMin: 800 })).toBe(
      true,
    );
    expect(rangesOverlap({ startMin: 600, endMin: 900 }, { startMin: 650, endMin: 700 })).toBe(
      true,
    );
  });
});
