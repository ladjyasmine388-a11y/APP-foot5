import { z } from 'zod';
import { PLAYER_LEVELS, PLAYER_POSITIONS } from '../enums';
import { citySchema, emailSchema } from './primitives';
import { dateSchema, timeSchema } from './venues';

/** Limites métier (une seule source de vérité pour l'API et les clients). */
export const TEAM_MAX_MEMBERS = 25;
export const TEAM_MAX_CAPTAIN_OF = 3;
export const TEAM_INVITATION_TTL_DAYS = 7;
export const TEAM_MAX_PENDING_INVITATIONS = 30;

// ───────────────────────── Équipes ─────────────────────────

const teamName = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}\s'’.&-]*$/u, 'Caractères non autorisés');

export const createTeamSchema = z
  .object({
    name: teamName,
    city: citySchema.optional(),
    level: z.enum(PLAYER_LEVELS).default('BEGINNER'),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z
  .object({
    name: teamName,
    city: citySchema.nullable(),
    level: z.enum(PLAYER_LEVELS),
    description: z.string().trim().min(1).max(500).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification fournie' });
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const listTeamsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(50).optional(),
    city: citySchema.optional(),
    level: z.enum(PLAYER_LEVELS).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;

/** Inviter un joueur : soit par son compte (`userId`), soit par son adresse email (même sans compte). Un seul des deux. */
export const inviteToTeamSchema = z
  .object({ userId: z.uuid().optional(), email: emailSchema.optional() })
  .strict()
  .refine((v) => (v.userId === undefined) !== (v.email === undefined), {
    message: 'Indiquez soit userId, soit email',
  });
export type InviteToTeamInput = z.infer<typeof inviteToTeamSchema>;

export const transferCaptaincySchema = z.object({ userId: z.uuid() }).strict();
export type TransferCaptaincyInput = z.infer<typeof transferCaptaincySchema>;

// ───────────────────────── Sessions « Complétez votre équipe » ─────────────────────────

/** Place d'un joueur : l'hôte occupe déjà une place, `spots` est le nombre de places À POURVOIR. */
export const createSoloSessionSchema = z
  .object({
    bookingId: z.uuid(),
    spots: z.number().int().min(1).max(15),
    level: z.enum(PLAYER_LEVELS).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    /** Part indicative par joueur (DZD), réglée entre joueurs : la plateforme n'encaisse rien pour cela. */
    pricePerPlayerMinor: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
export type CreateSoloSessionInput = z.infer<typeof createSoloSessionSchema>;

export const SOLO_SORTS = ['soonest', 'recommended', 'spots'] as const;

export const listSoloSessionsQuerySchema = z
  .object({
    city: citySchema.optional(),
    /** Adresse web du complexe. */
    venue: z.string().trim().min(1).max(120).optional(),
    date: dateSchema.optional(),
    time: timeSchema.optional(),
    window: z.coerce.number().int().min(0).max(720).default(0),
    level: z.enum(PLAYER_LEVELS).optional(),
    /** Nombre de places libres minimum. */
    spots: z.coerce.number().int().min(1).max(15).optional(),
    sort: z.enum(SOLO_SORTS).default('soonest'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict()
  .refine((v) => !v.time || v.date, { path: ['time'], message: 'L’heure nécessite une date' });
export type ListSoloSessionsQuery = z.infer<typeof listSoloSessionsQuerySchema>;

export const MY_ACTIVITY_FILTERS = ['upcoming', 'past', 'all'] as const;
export const listMyActivityQuerySchema = z
  .object({
    when: z.enum(MY_ACTIVITY_FILTERS).default('upcoming'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListMyActivityQuery = z.infer<typeof listMyActivityQuerySchema>;

// ───────────────────────── Trouvez un adversaire ─────────────────────────

export const createOpponentListingSchema = z
  .object({
    teamId: z.uuid(),
    bookingId: z.uuid(),
    /** Joueurs par équipe (5 à 8). Par défaut : le maximum que le terrain permet. */
    playersPerSide: z.number().int().min(5).max(8).optional(),
    level: z.enum(PLAYER_LEVELS).optional(),
    comment: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type CreateOpponentListingInput = z.infer<typeof createOpponentListingSchema>;

export const listOpponentListingsQuerySchema = z
  .object({
    city: citySchema.optional(),
    venue: z.string().trim().min(1).max(120).optional(),
    date: dateSchema.optional(),
    level: z.enum(PLAYER_LEVELS).optional(),
    playersPerSide: z.coerce.number().int().min(5).max(8).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListOpponentListingsQuery = z.infer<typeof listOpponentListingsQuerySchema>;

export const createMatchRequestSchema = z
  .object({ teamId: z.uuid(), message: z.string().trim().min(1).max(300).optional() })
  .strict();
export type CreateMatchRequestInput = z.infer<typeof createMatchRequestSchema>;

// ───────────────────────── Matchs ─────────────────────────

/** Match organisé par une équipe sur une de ses réservations (entraînement, match amical interne). */
export const createTeamMatchSchema = z
  .object({ teamId: z.uuid(), bookingId: z.uuid() })
  .strict();
export type CreateTeamMatchInput = z.infer<typeof createTeamMatchSchema>;

export const setScoreSchema = z
  .object({ scoreA: z.number().int().min(0).max(99), scoreB: z.number().int().min(0).max(99) })
  .strict();
export type SetScoreInput = z.infer<typeof setScoreSchema>;

// ───────────────────────── Réponses ─────────────────────────

export interface PersonView {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface TeamView {
  id: string;
  name: string;
  logoUrl: string | null;
  level: (typeof PLAYER_LEVELS)[number];
  city: string | null;
  description: string | null;
  captain: PersonView;
  memberCount: number;
  /** Mon rôle dans l'équipe (null si je n'en suis pas membre). */
  myRole: 'CAPTAIN' | 'MEMBER' | null;
  createdAt: string;
}

export interface TeamMemberView extends PersonView {
  role: 'CAPTAIN' | 'MEMBER';
  level: (typeof PLAYER_LEVELS)[number];
  preferredPosition: (typeof PLAYER_POSITIONS)[number];
  joinedAt: string;
}

export interface TeamInvitationView {
  id: string;
  team: { id: string; name: string; logoUrl: string | null };
  invitedBy: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
}

export interface TeamInvitationAdminView extends TeamInvitationView {
  /** Destinataire : nom du joueur, ou l'adresse email invitée. */
  invitee: string;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

interface SessionVenue {
  id: string;
  slug: string;
  name: string;
  city: string;
  district: string | null;
}

export interface SoloSessionView {
  id: string;
  status: 'OPEN' | 'FULL' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
  origin: 'PLAYER' | 'VENUE';
  startsAt: string;
  endsAt: string;
  venue: SessionVenue;
  field: { id: string; name: string; capacity: number };
  /** Places à pourvoir au total, places prises, places restantes. */
  spots: number;
  joinedCount: number;
  remaining: number;
  level: (typeof PLAYER_LEVELS)[number] | null;
  pricePerPlayerMinor: number;
  description: string | null;
  host: { id: string; name: string; avatarUrl: string | null };
  /** Vrai si le joueur connecté participe (ou organise). */
  joined: boolean;
  isHost: boolean;
  /** Joueurs inscrits, visibles seulement des utilisateurs connectés. */
  players: PersonView[] | null;
  matchId: string | null;
}

export interface MatchRequestView {
  id: string;
  listingId: string;
  status: 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  team: { id: string; name: string; logoUrl: string | null; level: (typeof PLAYER_LEVELS)[number]; memberCount: number };
  message: string | null;
  createdAt: string;
}

export interface OpponentListingView {
  id: string;
  status: 'OPEN' | 'ACCEPTED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
  startsAt: string;
  endsAt: string;
  venue: SessionVenue;
  field: { id: string; name: string; capacity: number };
  team: { id: string; name: string; logoUrl: string | null; level: (typeof PLAYER_LEVELS)[number]; memberCount: number };
  playersPerSide: number;
  level: (typeof PLAYER_LEVELS)[number] | null;
  comment: string | null;
  /** Nombre de demandes en attente (visible du capitaine de l'équipe annonceuse). */
  pendingRequests: number | null;
  /** Ma demande sur cette annonce, le cas échéant. */
  myRequest: { id: string; status: MatchRequestView['status']; teamId: string } | null;
  matchId: string | null;
  createdAt: string;
}

export interface MatchView {
  id: string;
  source: 'TEAM' | 'SOLO_SESSION' | 'OPPONENT_LISTING';
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
  startsAt: string;
  endsAt: string;
  venue: SessionVenue;
  field: { id: string; name: string };
  teamA: { id: string; name: string; logoUrl: string | null } | null;
  teamB: { id: string; name: string; logoUrl: string | null } | null;
  playersPerSide: number | null;
  level: (typeof PLAYER_LEVELS)[number] | null;
  scoreA: number | null;
  scoreB: number | null;
  participants: (PersonView & { side: 'A' | 'B' | 'NONE' })[];
  bookingId: string;
  soloSessionId: string | null;
  opponentListingId: string | null;
}
