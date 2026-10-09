import { z } from 'zod';
import { NOTIFICATION_TYPES } from '../enums';

// ───────────────────────── Notifications ─────────────────────────

export const listNotificationsQuerySchema = z
  .object({
    /** `true` : seulement les non lues. */
    unread: z.stringbool().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export interface NotificationView {
  id: string;
  type: (typeof NOTIFICATION_TYPES)[number];
  /** Texte déjà traduit dans la langue du compte (pratique pour le mobile) ; le web peut aussi traduire depuis `type` + `data`. */
  title: string;
  body: string;
  /** Données de rendu : identifiants et libellés d'affichage, jamais d'email ni de téléphone. */
  data: Record<string, string | number | null>;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

// ───────────────────────── Avis ─────────────────────────

export const REVIEW_WINDOW_DAYS = 30;

export const createReviewSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const listReviewsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

export interface ReviewView {
  id: string;
  rating: number;
  comment: string | null;
  /** Prénom et initiale du nom, jamais d'identifiant de compte. */
  author: string;
  createdAt: string;
}

export interface ReviewPage {
  items: ReviewView[];
  nextCursor: string | null;
  ratingAvg: number;
  ratingCount: number;
}

// ───────────────────────── Images envoyées ─────────────────────────

export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VENUE_MAX_PHOTOS = 10;

export interface UploadedImage {
  url: string;
}
