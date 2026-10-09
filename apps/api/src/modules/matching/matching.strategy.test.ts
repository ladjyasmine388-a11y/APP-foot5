import type { PlayerLevel } from '@footfive/shared';
import { describe, expect, it } from 'vitest';
import {
  MatchingStrategy,
  type PlayerProfile,
  type SessionCandidate,
  SimpleCriteriaStrategy,
} from './matching.strategy.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const inHours = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

const player = (level: PlayerLevel, overrides: Partial<PlayerProfile> = {}): PlayerProfile => ({
  id: 'p1',
  level,
  preferredPosition: 'ANY',
  city: 'Alger',
  reliabilityScore: 100,
  ...overrides,
});
const session = (overrides: Partial<SessionCandidate> = {}): SessionCandidate => ({
  id: 's1',
  startsAt: inHours(24),
  level: null,
  city: 'Alger',
  remaining: 4,
  spots: 4,
  ...overrides,
});

describe('SimpleCriteriaStrategy', () => {
  const strategy = new SimpleCriteriaStrategy();

  describe('compatibilité de niveau (règle dure)', () => {
    it('une session ouverte accepte tout le monde', () => {
      for (const level of ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const) {
        expect(strategy.isCompatible(player(level), session({ level: null }))).toBe(true);
      }
    });

    it('accepte le même niveau et les niveaux voisins (±1)', () => {
      expect(
        strategy.isCompatible(player('INTERMEDIATE'), session({ level: 'INTERMEDIATE' })),
      ).toBe(true);
      expect(strategy.isCompatible(player('BEGINNER'), session({ level: 'INTERMEDIATE' }))).toBe(
        true,
      );
      expect(strategy.isCompatible(player('ADVANCED'), session({ level: 'INTERMEDIATE' }))).toBe(
        true,
      );
    });

    it('refuse un écart de deux niveaux (débutant ↔ avancé)', () => {
      expect(strategy.isCompatible(player('BEGINNER'), session({ level: 'ADVANCED' }))).toBe(false);
      expect(strategy.isCompatible(player('ADVANCED'), session({ level: 'BEGINNER' }))).toBe(false);
    });
  });

  describe('score (classement uniquement)', () => {
    it('le même niveau passe devant un niveau voisin', () => {
      const same = strategy.score(player('INTERMEDIATE'), session({ level: 'INTERMEDIATE' }), NOW);
      const adjacent = strategy.score(player('INTERMEDIATE'), session({ level: 'ADVANCED' }), NOW);
      expect(same).toBeGreaterThan(adjacent);
    });

    it('la même ville passe devant (insensible à la casse)', () => {
      const here = strategy.score(player('BEGINNER'), session({ city: 'alger' }), NOW);
      const far = strategy.score(player('BEGINNER'), session({ city: 'Oran' }), NOW);
      expect(here).toBeGreaterThan(far);
    });

    it('une session presque pleine passe devant, pour aider à la compléter', () => {
      const almost = strategy.score(player('BEGINNER'), session({ remaining: 1 }), NOW);
      const empty = strategy.score(player('BEGINNER'), session({ remaining: 6 }), NOW);
      expect(almost).toBeGreaterThan(empty);
    });

    it('les sessions imminentes passent devant les lointaines', () => {
      const soon = strategy.score(player('BEGINNER'), session({ startsAt: inHours(2) }), NOW);
      const later = strategy.score(player('BEGINNER'), session({ startsAt: inHours(150) }), NOW);
      expect(soon).toBeGreaterThan(later);
    });
  });

  describe('rank', () => {
    it('exclut les sessions incompatibles et classe les autres par pertinence', () => {
      const sessions = [
        session({ id: 'avancé', level: 'ADVANCED' }), // incompatible avec un débutant
        session({ id: 'ouverte-loin', city: 'Oran' }),
        session({ id: 'même-niveau', level: 'BEGINNER' }),
        session({ id: 'ouverte-ici' }),
      ];
      const ranked = strategy.rank(player('BEGINNER'), sessions, NOW);
      expect(ranked.map((r) => r.session.id)).toEqual([
        'même-niveau',
        'ouverte-ici',
        'ouverte-loin',
      ]);
    });

    it('départage deux scores égaux par l’heure de début', () => {
      const ranked = strategy.rank(
        player('BEGINNER'),
        [
          session({ id: 'tard', startsAt: inHours(300) }),
          session({ id: 'tôt', startsAt: inHours(300) }),
        ],
        NOW,
      );
      expect(ranked).toHaveLength(2);
    });

    it('ne modifie pas la liste d’origine', () => {
      const sessions = [session({ id: 'a' }), session({ id: 'b', level: 'BEGINNER' })];
      const copy = [...sessions];
      strategy.rank(player('BEGINNER'), sessions, NOW);
      expect(sessions).toEqual(copy);
    });
  });

  it('respecte le contrat abstrait : une autre stratégie peut remplacer celle-ci sans toucher au reste', () => {
    class AlwaysYes extends MatchingStrategy {
      isCompatible(): boolean {
        return true;
      }
      score(): number {
        return 1;
      }
    }
    expect(
      new AlwaysYes().rank(player('BEGINNER'), [session({ level: 'ADVANCED' })], NOW),
    ).toHaveLength(1);
  });
});
