import { HttpStatus, Injectable } from '@nestjs/common';
import type { ManageSlot, PublicSlot } from '@footfive/shared';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, daysBetween, todayIn } from '../../common/time/zoned-time.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  type BookingRow,
  type ComputedSlot,
  type HourRowWithField,
  type PriceRule,
  bookingWindow,
  buildFieldSlots,
} from './availability.engine.js';

/** Statuts qui occupent un créneau : identiques à la clause WHERE de la contrainte SQL `Booking_no_overlap`. */
const OCCUPYING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'] as const;

export interface FieldDay {
  field: { id: string; name: string; capacity: number; slotDurationMin: number };
  slots: ComputedSlot[];
}

export interface FoundSlot {
  venue: {
    id: string;
    name: string;
    status: 'PENDING' | 'APPROVED' | 'SUSPENDED';
    timezone: string;
    depositPolicy: unknown;
    cancellationPolicy: unknown;
  };
  field: { id: string; name: string; capacity: number; slotDurationMin: number };
  /** Jour de service du créneau. */
  date: string;
  slot: ComputedSlot | null;
}

export interface VenueDay {
  timezone: string;
  fields: FieldDay[];
}

/** Données d'un terrain nécessaires au calcul, telles que chargées en base. */
export interface FieldInputs {
  id: string;
  name: string;
  capacity: number;
  slotDurationMin: number;
  pricingRules: {
    id: string;
    weekdays: number[];
    startMin: number;
    endMin: number;
    priceMinor: number;
    priority: number;
    validFrom: Date | null;
    validTo: Date | null;
    isActive: boolean;
  }[];
}

export function toPriceRule(row: FieldInputs['pricingRules'][number]): PriceRule {
  return {
    id: row.id,
    weekdays: row.weekdays,
    startMin: row.startMin,
    endMin: row.endMin,
    priceMinor: row.priceMinor,
    priority: row.priority,
    // Colonnes `DATE` : Prisma les renvoie à minuit UTC.
    validFrom: row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null,
    validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null,
    isActive: row.isActive,
  };
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Refuse une date hors de la fenêtre de réservation : passée (la veille reste acceptée, car un créneau
   * de 01:00 appartient encore au jour de service précédent) ou au-delà de l'horizon réglé par l'admin.
   */
  async assertDateInRange(date: string, timeZone: string, now: Date = new Date()): Promise<void> {
    const delta = daysBetween(todayIn(timeZone, now), date);
    const maxDays = await this.settings.getInt('booking.max_days_ahead', 60);
    if (delta < -1) throw outOfRange('La date est passée', 'date_in_past');
    if (delta > maxDays) {
      throw outOfRange(`Réservation possible jusqu’à ${maxDays} jours à l’avance`, 'date_too_far');
    }
  }

  /** Charge les réservations qui occupent les terrains entre deux instants, groupées par terrain. */
  async loadOccupancy(
    fieldIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, BookingRow[]>> {
    const result = new Map<string, BookingRow[]>(fieldIds.map((id) => [id, []]));
    if (fieldIds.length === 0) return result;

    const rows = await this.prisma.booking.findMany({
      where: {
        fieldId: { in: [...fieldIds] },
        status: { in: [...OCCUPYING_STATUSES] },
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      select: {
        fieldId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        bookingType: true,
        holdExpiresAt: true,
      },
    });
    for (const row of rows) result.get(row.fieldId)?.push(row);
    return result;
  }

  /** Disponibilité d'un jour pour les terrains ACTIFS d'un complexe (ou d'un seul terrain). */
  async getVenueDay(
    venueId: string,
    date: string,
    options: { fieldId?: string; now?: Date } = {},
  ): Promise<VenueDay | null> {
    const now = options.now ?? new Date();
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        timezone: true,
        openingHours: true,
        fields: {
          where: { isActive: true, ...(options.fieldId ? { id: options.fieldId } : {}) },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            capacity: true,
            slotDurationMin: true,
            pricingRules: { where: { isActive: true } },
          },
        },
      },
    });
    if (!venue) return null;

    const minLeadMinutes = await this.settings.getInt('booking.min_lead_minutes', 30);
    const fields = await this.computeFields({
      fields: venue.fields,
      hours: venue.openingHours,
      timeZone: venue.timezone,
      date,
      now,
      minLeadMinutes,
    });
    return { timezone: venue.timezone, fields };
  }

  /**
   * Retrouve LE créneau qui commence exactement à `startsAt` sur un terrain (pour le réserver).
   * Retourne null si le terrain n'existe pas ou est inactif ; `slot` est null si l'instant ne correspond à aucun
   * créneau de la grille (horaires, durée) — jamais de créneau « inventé » par le client.
   * Un créneau après minuit appartient au jour de service précédent : on regarde la date locale ET la veille.
   */
  async findSlot(
    fieldId: string,
    startsAt: Date,
    now: Date = new Date(),
  ): Promise<FoundSlot | null> {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, isActive: true },
      select: {
        venueId: true,
        venue: {
          select: {
            id: true,
            name: true,
            status: true,
            timezone: true,
            depositPolicy: true,
            cancellationPolicy: true,
          },
        },
      },
    });
    if (!field) return null;

    const localDate = todayIn(field.venue.timezone, startsAt);
    for (const date of [localDate, addDays(localDate, -1)]) {
      const day = await this.getVenueDay(field.venueId, date, { fieldId, now });
      const fieldDay = day?.fields[0];
      const slot = fieldDay?.slots.find((s) => s.startsAt.getTime() === startsAt.getTime());
      if (fieldDay && slot) return { venue: field.venue, field: fieldDay.field, date, slot };
    }
    // Aucun créneau à cet instant : on renvoie quand même le terrain pour un message d'erreur précis.
    const fallbackDay = await this.getVenueDay(field.venueId, localDate, { fieldId, now });
    const fallbackField = fallbackDay?.fields[0]?.field;
    return fallbackField
      ? { venue: field.venue, field: fallbackField, date: localDate, slot: null }
      : {
          venue: field.venue,
          field: { id: fieldId, name: '', capacity: 0, slotDurationMin: 60 },
          date: localDate,
          slot: null,
        };
  }

  /** Calcule les créneaux des terrains d'UN complexe (une seule requête de réservations). */
  async computeFields(args: {
    fields: readonly FieldInputs[];
    hours: readonly HourRowWithField[];
    timeZone: string;
    date: string;
    now: Date;
    minLeadMinutes: number;
  }): Promise<FieldDay[]> {
    const { fields, hours, timeZone, ...rest } = args;
    const slots = await this.computeBatch([{ fields, hours, timeZone }], rest);
    return fields.map((field) => ({
      field: {
        id: field.id,
        name: field.name,
        capacity: field.capacity,
        slotDurationMin: field.slotDurationMin,
      },
      slots: slots.get(field.id) ?? [],
    }));
  }

  /**
   * Calcule les créneaux de TOUS les terrains de PLUSIEURS complexes avec UNE SEULE requête de réservations
   * (la recherche par date ne doit pas faire une requête par complexe). Retourne les créneaux par identifiant de terrain.
   */
  async computeBatch(
    groups: readonly {
      fields: readonly FieldInputs[];
      hours: readonly HourRowWithField[];
      timeZone: string;
    }[],
    options: { date: string; now: Date; minLeadMinutes: number },
  ): Promise<Map<string, ComputedSlot[]>> {
    const { date, now, minLeadMinutes } = options;

    const windows: { from: Date; to: Date }[] = [];
    const fieldIds: string[] = [];
    for (const { fields, hours, timeZone } of groups) {
      for (const field of fields) {
        const window = bookingWindow({ date, timeZone, fieldId: field.id, hours });
        if (window) {
          windows.push(window);
          fieldIds.push(field.id);
        }
      }
    }

    const occupancy =
      windows.length > 0
        ? await this.loadOccupancy(
            fieldIds,
            new Date(Math.min(...windows.map((w) => w.from.getTime()))),
            new Date(Math.max(...windows.map((w) => w.to.getTime()))),
          )
        : new Map<string, BookingRow[]>();

    const result = new Map<string, ComputedSlot[]>();
    for (const { fields, hours, timeZone } of groups) {
      for (const field of fields) {
        result.set(
          field.id,
          buildFieldSlots({
            date,
            timeZone,
            slotDurationMin: field.slotDurationMin,
            fieldId: field.id,
            hours,
            rules: field.pricingRules.map(toPriceRule),
            bookings: occupancy.get(field.id) ?? [],
            now,
            minLeadMinutes,
          }),
        );
      }
    }
    return result;
  }
}

function outOfRange(message: string, code: string): AppException {
  return new AppException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, message, [
    { path: 'date', message, code },
  ]);
}

// ───────────────────────── Vues ─────────────────────────

/**
 * Vue PUBLIQUE d'un créneau. Ne divulgue pas POURQUOI il est indisponible (réservé, bloqué par le complexe,
 * passé) : ce serait révéler le taux de remplissage d'un concurrent. Les créneaux sans prix (non vendables)
 * sont masqués.
 */
export function toPublicSlots(slots: readonly ComputedSlot[]): PublicSlot[] {
  return slots
    .filter((s) => s.status !== 'NO_PRICE')
    .map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      priceMinor: s.priceMinor,
      status: s.status === 'AVAILABLE' ? 'AVAILABLE' : s.status === 'HELD' ? 'HELD' : 'UNAVAILABLE',
    }));
}

/** Vue COMPLÈTE réservée au personnel du complexe. */
export function toManageSlots(slots: readonly ComputedSlot[]): ManageSlot[] {
  return slots.map((s) => ({
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    priceMinor: s.priceMinor,
    status: s.status,
  }));
}
