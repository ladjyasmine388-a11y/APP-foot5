import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CreateFieldInput,
  type CreatePricingRuleInput,
  type CreateVenueInput,
  type DayAvailability,
  type ManageSlot,
  type ManageFieldView,
  type ManageVenueDetail,
  type ManageVenueSummary,
  type OpeningHoursInput,
  type PricingRuleView,
  type UpdateFieldInput,
  type UpdatePricingRuleInput,
  type UpdateVenueInput,
  toMinuteRange,
} from '@footfive/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AvailabilityService, toManageSlots } from '../availability/availability.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PoliciesService } from '../policies/policies.service.js';
import { minPrice, toOpeningHoursView, toPricingRuleView } from './venue.mappers.js';
import { slugCandidate, slugify } from './slug.js';

const toDate = (ymd: string | null | undefined): Date | null | undefined =>
  ymd === undefined ? undefined : ymd === null ? null : new Date(`${ymd}T00:00:00.000Z`);

const conflict = (message: string): AppException =>
  new AppException('CONFLICT', HttpStatus.CONFLICT, message);

@Injectable()
export class VenuesManageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly audit: AuditService,
    private readonly availability: AvailabilityService,
  ) {}

  // ───────────────────────── Complexes ─────────────────────────

  /** Crée un complexe EN ATTENTE d'approbation ; le créateur en devient le propriétaire. */
  async createVenue(
    user: AuthUser,
    input: CreateVenueInput,
    ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    const base = slugify(input.name);

    for (let attempt = 0; attempt < 6; attempt++) {
      const slug = slugCandidate(base, attempt);
      try {
        const venue = await this.prisma.$transaction(async (tx) => {
          const created = await tx.venue.create({
            data: {
              slug,
              name: input.name,
              description: input.description,
              city: input.city,
              district: input.district,
              address: input.address,
              latitude: input.latitude,
              longitude: input.longitude,
              phone: input.phone,
              amenities: input.amenities ?? [],
              timezone: input.timezone,
              // status : toujours PENDING (valeur par défaut) — jamais choisi par le demandeur.
              staff: { create: { userId: user.id, role: 'OWNER' } },
            },
          });
          await this.audit.record(
            {
              actorId: user.id,
              actorRole: 'VENUE_OWNER',
              action: 'venue.create',
              entityType: 'Venue',
              entityId: created.id,
              after: { name: created.name, city: created.city },
            },
            ctx,
            tx,
          );
          return created;
        });
        return this.loadDetail(venue.id, 'OWNER');
      } catch (error) {
        if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) continue; // slug déjà pris : on réessaie avec un suffixe
        throw error;
      }
    }
    throw conflict('Impossible de générer une adresse unique pour ce complexe, réessayez');
  }

  async listMine(user: AuthUser): Promise<ManageVenueSummary[]> {
    const memberships = await this.prisma.venueStaff.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        venue: {
          select: {
            id: true,
            slug: true,
            name: true,
            city: true,
            status: true,
            _count: { select: { fields: { where: { isActive: true } } } },
          },
        },
      },
    });
    return memberships.map(({ role, venue }) => ({
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      city: venue.city,
      status: venue.status,
      role,
      fieldsCount: venue._count.fields,
    }));
  }

  async getVenue(user: AuthUser, venueId: string): Promise<ManageVenueDetail> {
    const access = await this.policies.requireVenueRole(user, venueId, 'STAFF');
    return this.loadDetail(venueId, access.role);
  }

  async updateVenue(
    user: AuthUser,
    venueId: string,
    input: UpdateVenueInput,
    ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const { cancellationPolicy, ...rest } = input;
    const data: Prisma.VenueUpdateInput = { ...rest };
    if (cancellationPolicy !== undefined) {
      data.cancellationPolicy = cancellationPolicy === null ? Prisma.DbNull : cancellationPolicy;
    }

    const before = await this.prisma.venue.findUniqueOrThrow({ where: { id: venueId } });
    await this.prisma.$transaction(async (tx) => {
      await tx.venue.update({ where: { id: venueId }, data });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'venue.update',
          entityType: 'Venue',
          entityId: venueId,
          before: pickChanged(before, input),
          after: input as Prisma.InputJsonValue,
        },
        ctx,
        tx,
      );
    });
    return this.loadDetail(venueId, access.role);
  }

  // ───────────────────────── Terrains ─────────────────────────

  async createField(
    user: AuthUser,
    venueId: string,
    input: CreateFieldInput,
    ctx: RequestContext,
  ): Promise<ManageFieldView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    try {
      const field = await this.prisma.$transaction(async (tx) => {
        const created = await tx.field.create({ data: { ...input, venueId } });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: access.role,
            action: 'field.create',
            entityType: 'Field',
            entityId: created.id,
            after: { venueId, name: created.name, capacity: created.capacity },
          },
          ctx,
          tx,
        );
        return created;
      });
      return this.loadField(venueId, field.id);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('Un terrain porte déjà ce nom dans ce complexe');
      throw error;
    }
  }

  async updateField(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    input: UpdateFieldInput,
    ctx: RequestContext,
  ): Promise<ManageFieldView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const before = await this.requireField(venueId, fieldId);

    // Changer la durée des créneaux désalignerait les réservations à venir.
    if (input.slotDurationMin !== undefined && input.slotDurationMin !== before.slotDurationMin) {
      const upcoming = await this.prisma.booking.count({
        where: {
          fieldId,
          endsAt: { gt: new Date() },
          status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
        },
      });
      if (upcoming > 0) {
        throw conflict(
          'Impossible de changer la durée des créneaux : des réservations à venir existent sur ce terrain',
        );
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.field.update({ where: { id: fieldId }, data: input });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: access.role,
            action: 'field.update',
            entityType: 'Field',
            entityId: fieldId,
            before: pickChanged(before, input),
            after: input as Prisma.InputJsonValue,
          },
          ctx,
          tx,
        );
      });
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION))
        throw conflict('Un terrain porte déjà ce nom dans ce complexe');
      throw error;
    }
    return this.loadField(venueId, fieldId);
  }

  /** « Supprimer » = désactiver : le terrain disparaît des recherches, l'historique des réservations est conservé. */
  async deactivateField(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.requireField(venueId, fieldId);
    await this.prisma.$transaction(async (tx) => {
      await tx.field.update({ where: { id: fieldId }, data: { isActive: false } });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'field.deactivate',
          entityType: 'Field',
          entityId: fieldId,
        },
        ctx,
        tx,
      );
    });
  }

  // ───────────────────────── Horaires ─────────────────────────

  async setVenueHours(
    user: AuthUser,
    venueId: string,
    input: OpeningHoursInput,
    ctx: RequestContext,
  ): Promise<ManageVenueDetail> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.replaceHours(user, access.role, venueId, null, input, ctx);
    return this.loadDetail(venueId, access.role);
  }

  /** Horaires PROPRES à un terrain. `days: []` supprime la surcharge : le terrain suit de nouveau le complexe. */
  async setFieldHours(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    input: OpeningHoursInput,
    ctx: RequestContext,
  ): Promise<ManageFieldView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.requireField(venueId, fieldId);
    await this.replaceHours(user, access.role, venueId, fieldId, input, ctx);
    return this.loadField(venueId, fieldId);
  }

  private async replaceHours(
    user: AuthUser,
    role: string,
    venueId: string,
    fieldId: string | null,
    input: OpeningHoursInput,
    ctx: RequestContext,
  ): Promise<void> {
    const rows = input.days.flatMap((day) =>
      day.intervals.map((interval) => {
        // Le schéma a déjà validé chaque plage ; on reconvertit ici pour ne pas supposer l'ordre des validations.
        const range = toMinuteRange(interval.from, interval.to);
        if (!range)
          throw new AppException(
            'VALIDATION_ERROR',
            HttpStatus.BAD_REQUEST,
            'Plage horaire invalide',
          );
        return {
          venueId,
          fieldId,
          weekday: day.weekday,
          opensAtMin: range.startMin,
          closesAtMin: range.endMin,
        };
      }),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.openingHour.deleteMany({ where: { venueId, fieldId } });
      if (rows.length > 0) await tx.openingHour.createMany({ data: rows });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: role,
          action: fieldId ? 'field.hours.update' : 'venue.hours.update',
          entityType: fieldId ? 'Field' : 'Venue',
          entityId: fieldId ?? venueId,
          after: input as Prisma.InputJsonValue,
        },
        ctx,
        tx,
      );
    });
  }

  // ───────────────────────── Tarifs ─────────────────────────

  async listPricingRules(
    user: AuthUser,
    venueId: string,
    fieldId: string,
  ): Promise<PricingRuleView[]> {
    await this.policies.requireVenueRole(user, venueId, 'STAFF');
    await this.requireField(venueId, fieldId);
    const rules = await this.prisma.pricingRule.findMany({
      where: { fieldId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return rules.map(toPricingRuleView);
  }

  async createPricingRule(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    input: CreatePricingRuleInput,
    ctx: RequestContext,
  ): Promise<PricingRuleView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.requireField(venueId, fieldId);
    const range = toMinuteRange(input.from, input.to);
    if (!range) throw invalidRange();

    const rule = await this.prisma.$transaction(async (tx) => {
      const created = await tx.pricingRule.create({
        data: {
          fieldId,
          weekdays: input.weekdays,
          startMin: range.startMin,
          endMin: range.endMin,
          priceMinor: input.priceMinor,
          priority: input.priority ?? 0,
          validFrom: toDate(input.validFrom) ?? null,
          validTo: toDate(input.validTo) ?? null,
          isActive: input.isActive ?? true,
        },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'pricing.create',
          entityType: 'PricingRule',
          entityId: created.id,
          after: ruleSnapshot(created),
        },
        ctx,
        tx,
      );
      return created;
    });
    return toPricingRuleView(rule);
  }

  async updatePricingRule(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    ruleId: string,
    input: UpdatePricingRuleInput,
    ctx: RequestContext,
  ): Promise<PricingRuleView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.requireField(venueId, fieldId);
    const before = await this.requireRule(fieldId, ruleId);

    // Un seul des deux bornes horaires peut être fourni : on la combine avec l'existante, puis on revalide.
    const current = toPricingRuleView(before);
    const range = toMinuteRange(input.from ?? current.from, input.to ?? current.to);
    if (!range) throw invalidRange();
    const validFrom = input.validFrom === undefined ? current.validFrom : input.validFrom;
    const validTo = input.validTo === undefined ? current.validTo : input.validTo;
    if (validFrom && validTo && validTo < validFrom) {
      throw new AppException(
        'VALIDATION_ERROR',
        HttpStatus.BAD_REQUEST,
        'La fin de validité précède le début',
      );
    }

    const rule = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.pricingRule.update({
        where: { id: ruleId },
        data: {
          weekdays: input.weekdays,
          startMin: range.startMin,
          endMin: range.endMin,
          priceMinor: input.priceMinor,
          priority: input.priority,
          validFrom: toDate(input.validFrom),
          validTo: toDate(input.validTo),
          isActive: input.isActive,
        },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'pricing.update',
          entityType: 'PricingRule',
          entityId: ruleId,
          before: ruleSnapshot(before),
          after: ruleSnapshot(updated),
        },
        ctx,
        tx,
      );
      return updated;
    });
    return toPricingRuleView(rule);
  }

  async deletePricingRule(
    user: AuthUser,
    venueId: string,
    fieldId: string,
    ruleId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    await this.requireField(venueId, fieldId);
    const before = await this.requireRule(fieldId, ruleId);
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingRule.delete({ where: { id: ruleId } });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'pricing.delete',
          entityType: 'PricingRule',
          entityId: ruleId,
          before: ruleSnapshot(before),
        },
        ctx,
        tx,
      );
    });
  }

  // ───────────────────────── Calendrier (vue complète) ─────────────────────────

  /** Créneaux d'un jour avec TOUS les statuts (réservé, bloqué, passé, sans prix…), pour le personnel. */
  async getAvailability(
    user: AuthUser,
    venueId: string,
    date: string,
  ): Promise<DayAvailability<ManageSlot>> {
    await this.policies.requireVenueRole(user, venueId, 'STAFF');
    const day = await this.availability.getVenueDay(venueId, date);
    if (!day) throw Errors.notFound('Complexe introuvable');
    return {
      date,
      timezone: day.timezone,
      fields: day.fields.map(({ field, slots }) => ({
        fieldId: field.id,
        name: field.name,
        capacity: field.capacity,
        slotDurationMin: field.slotDurationMin,
        slots: toManageSlots(slots),
      })),
    };
  }

  // ───────────────────────── Chargements ─────────────────────────

  /** Un terrain n'est accessible QUE via son propre complexe : un identifiant d'un autre complexe donne 404. */
  private async requireField(venueId: string, fieldId: string) {
    const field = await this.prisma.field.findFirst({ where: { id: fieldId, venueId } });
    if (!field) throw Errors.notFound('Terrain introuvable');
    return field;
  }

  private async requireRule(fieldId: string, ruleId: string) {
    const rule = await this.prisma.pricingRule.findFirst({ where: { id: ruleId, fieldId } });
    if (!rule) throw Errors.notFound('Règle de prix introuvable');
    return rule;
  }

  private async loadField(venueId: string, fieldId: string): Promise<ManageFieldView> {
    const detail = await this.loadDetail(venueId, 'ADMIN');
    const field = detail.fields.find((f) => f.id === fieldId);
    if (!field) throw Errors.notFound('Terrain introuvable');
    return field;
  }

  private async loadDetail(
    venueId: string,
    role: ManageVenueDetail['role'],
  ): Promise<ManageVenueDetail> {
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: venueId },
      include: {
        openingHours: true,
        fields: {
          orderBy: { name: 'asc' },
          include: { pricingRules: { orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] } },
        },
      },
    });

    return {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      description: venue.description,
      city: venue.city,
      district: venue.district,
      address: venue.address,
      latitude: venue.latitude,
      longitude: venue.longitude,
      phone: venue.phone,
      timezone: venue.timezone,
      amenities: venue.amenities,
      photos: venue.photos,
      status: venue.status,
      cancellationPolicy:
        (venue.cancellationPolicy as ManageVenueDetail['cancellationPolicy']) ?? null,
      role,
      openingHours: toOpeningHoursView(venue.openingHours.filter((h) => h.fieldId === null)),
      fields: venue.fields.map((f) => ({
        id: f.id,
        name: f.name,
        capacity: f.capacity,
        dimensions: f.dimensions,
        surface: f.surface,
        lighting: f.lighting,
        covered: f.covered,
        photos: f.photos,
        description: f.description,
        slotDurationMin: f.slotDurationMin,
        priceFromMinor: minPrice(f.pricingRules),
        isActive: f.isActive,
        openingHours: toOpeningHoursView(venue.openingHours.filter((h) => h.fieldId === f.id)),
        pricingRules: f.pricingRules.map(toPricingRuleView),
      })),
    };
  }
}

// ───────────────────────── Aides ─────────────────────────

function invalidRange(): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    HttpStatus.BAD_REQUEST,
    'Plage horaire invalide (début = fin, ou fin après 06:00 le lendemain)',
  );
}

/** Valeurs actuelles des seuls champs que la requête va modifier (pour l'audit « avant / après »). */
function pickChanged(row: object, changes: object): Prisma.InputJsonValue {
  const record = row as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(changes).map((key) => [key, record[key] ?? null]),
  ) as Prisma.InputJsonValue;
}

function ruleSnapshot(rule: {
  weekdays: number[];
  startMin: number;
  endMin: number;
  priceMinor: number;
  priority: number;
  isActive: boolean;
}): Prisma.InputJsonValue {
  return {
    weekdays: rule.weekdays,
    startMin: rule.startMin,
    endMin: rule.endMin,
    priceMinor: rule.priceMinor,
    priority: rule.priority,
    isActive: rule.isActive,
  };
}
