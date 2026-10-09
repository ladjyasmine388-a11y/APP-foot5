import type { PlayerLevel, PlayerPosition } from '@footfive/shared';

/**
 * MISE EN RELATION joueurs ↔ sessions « Complétez votre équipe ».
 *
 * Le reste de l'application ne dépend QUE de ce contrat. Le MVP utilise des critères simples
 * (`SimpleCriteriaStrategy`) ; un algorithme plus fin (position, distance, historique, fiabilité, âge, horaires
 * habituels…) s'ajoutera en écrivant une autre stratégie et en la branchant dans `matching.module.ts`,
 * sans toucher aux sessions, aux API ni au schéma.
 */

export interface PlayerProfile {
  id: string;
  level: PlayerLevel;
  preferredPosition: PlayerPosition;
  city: string | null;
  /** 0..100, calculée par le serveur (jamais déclarée par le joueur). */
  reliabilityScore: number;
}

export interface SessionCandidate {
  id: string;
  startsAt: Date;
  /** Niveau demandé par l'hôte ; null = ouvert à tous. */
  level: PlayerLevel | null;
  city: string;
  remaining: number;
  spots: number;
}

export interface ScoredSession<S extends SessionCandidate = SessionCandidate> {
  session: S;
  /** Plus c'est haut, mieux ça correspond. Sert uniquement à TRIER. */
  score: number;
}

export abstract class MatchingStrategy {
  /** Le joueur a-t-il le droit de rejoindre cette session ? Règle dure, appliquée à l'inscription. */
  abstract isCompatible(player: PlayerProfile, session: SessionCandidate): boolean;

  /** Pertinence d'une session pour un joueur. Ne sert qu'à classer, jamais à autoriser. */
  abstract score(player: PlayerProfile, session: SessionCandidate, now: Date): number;

  /** Sessions compatibles, de la plus pertinente à la moins pertinente. */
  rank<S extends SessionCandidate>(player: PlayerProfile, sessions: readonly S[], now: Date): ScoredSession<S>[] {
    return sessions
      .filter((s) => this.isCompatible(player, s))
      .map((session) => ({ session, score: this.score(player, session, now) }))
      .sort((a, b) => b.score - a.score || a.session.startsAt.getTime() - b.session.startsAt.getTime());
  }
}

const LEVEL_RANK: Record<PlayerLevel, number> = { BEGINNER: 0, INTERMEDIATE: 1, ADVANCED: 2 };

/**
 * Critères du MVP : même session, même date, même heure, même lieu (garantis par la session elle-même) et
 * niveau compatible. Un joueur peut rejoindre une session dont le niveau est le sien ou voisin (±1) ; une session
 * « ouverte » accepte tout le monde.
 */
export class SimpleCriteriaStrategy extends MatchingStrategy {
  isCompatible(player: PlayerProfile, session: SessionCandidate): boolean {
    if (session.level === null) return true;
    return Math.abs(LEVEL_RANK[player.level] - LEVEL_RANK[session.level]) <= 1;
  }

  score(player: PlayerProfile, session: SessionCandidate, now: Date): number {
    let score = 100;
    if (session.level !== null) {
      const gap = Math.abs(LEVEL_RANK[player.level] - LEVEL_RANK[session.level]);
      score += gap === 0 ? 30 : 10;
    }
    if (player.city && player.city.toLowerCase() === session.city.toLowerCase()) score += 20;
    // Aider à compléter : une session presque pleine passe devant.
    if (session.remaining <= 2) score += 15;
    // Les sessions imminentes d'abord (jusqu'à 10 points, décroissant sur une semaine).
    const hoursAhead = Math.max(0, (session.startsAt.getTime() - now.getTime()) / 3_600_000);
    score += Math.max(0, 10 - hoursAhead / 16.8);
    return Math.round(score * 10) / 10;
  }
}
