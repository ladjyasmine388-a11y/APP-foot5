import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminListVenuesQuery,
  type AdminVenueView,
  type PageOf,
  type SetVenueDepositPolicyInput,
  type VenueApprovalInput,
  type VenueRejectionInput,
} from '@footfive/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { decodeOffset, displayName, encodeOffset } from '../teams/teams.service.js';
import { AdminCommissionService } from './admin-commission.service.js';

type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';

/** Transitions autorisées : une décision ne s'applique que depuis le statut attendu. */
const TRANSITIONS: Record<Decision, { from: ('PENDING' | 'APPROVED' | 'SUSPENDED' | 'REJECTED')[]; to: 'APPROVED' | 'SUSPENDED' | 'REJECTED' }> = {
  approve: { from: ['PENDING', 'REJECTED'], to: 'APPROVED' },
  reject: { from: ['PENDING'], to: 'REJECTED' },
  suspend: { from: ['APPROVED'], to: 'SUSPENDED' },
  reinstate: { from: ['SUSPENDED'], to: 'APPROVED' },
};

const venueInclude = {
  _count: { select: { fields: { where: { isActive: true } } } },
  staff: { where: { role: 'OWNER' }, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true } } } },
} satisfies Prisma.VenueInclude;
type VenueRow = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;

@Injectable()
export class AdminVenuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly commission: AdminCommissionService,
  ) {}

  async list(query: AdminListVenuesQuery): Promise<PageOf<AdminVenueView>> {
    const offset = decodeOffset(query.cursor);
    const where: Prisma.VenueWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
      ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { address: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const rows = await this.prisma.venue.findMany({
      where,
      include: venueInclude,
      // Les demandes à traiter d'abord (les plus anciennes en tête), puis le reste par date de création.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const effective = await this.commission.effectiveFor(page.map((v) => v.id));
    return {
      items: page.map((v) => this.toView(v, effective.get(v.id))),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  async get(id: string): Promise<AdminVenueView> {
    const row = await this.prisma.venue.findUnique({ where: { id }, include: venueInclude });
    if (!row) throw Errors.notFound('Complexe introuvable');
    return this.toView(row, (await this.commission.effectiveFor([id])).get(id));
  }

  approve = (admin: AuthUser, id: string, input: VenueApprovalInput, ctx: RequestContext) => this.decide('approve', admin, id, input.reason ?? null, ctx);
  reinstate = (admin: AuthUser, id: string, input: VenueApprovalInput, ctx: RequestContext) => this.decide('reinstate', admin, id, input.reason ?? null, ctx);
  reject = (admin: AuthUser, id: string, input: VenueRejectionInput, ctx: RequestContext) => this.decide('reject', admin, id, input.reason, ctx);
  suspend = (admin: AuthUser, id: string, input: VenueRejectionInput, ctx: RequestContext) => this.decide('suspend', admin, id, input.reason, ctx);

  /**
   * Décision sur un complexe. Le changement de statut est ATOMIQUE et conditionné à l'état de départ : deux
   * administrateurs qui décident en même temps ne peuvent pas se marcher dessus (le second reçoit 409).
   * Suspendre ou refuser masque le complexe partout ; les réservations déjà confirmées ne sont pas annulées
   * automatiquement (le gérant et le joueur gèrent leur cas, l'administration peut rembourser).
   */
  private async decide(decision: Decision, admin: AuthUser, id: string, reason: string | null, ctx: RequestContext, now: Date = new Date()): Promise<AdminVenueView> {
    const rule = TRANSITIONS[decision];
    const venue = await this.prisma.venue.findUnique({ where: { id }, select: { name: true, status: true, _count: { select: { fields: { where: { isActive: true } } } } } });
    if (!venue) throw Errors.notFound('Complexe introuvable');
    if (rule.to === 'APPROVED' && venue._count.fields === 0) {
      throw new AppException('CONFLICT', HttpStatus.CONFLICT, 'Le complexe doit avoir au moins un terrain actif pour être approuvé');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.venue.updateManyAndReturn({
        where: { id, status: { in: rule.from } },
        data: { status: rule.to, statusReason: reason, statusChangedAt: now },
        select: { id: true },
      });
      if (claimed.length === 0) {
        throw new AppException('CONFLICT', HttpStatus.CONFLICT, `Décision impossible : le complexe est « ${venue.status} » (attendu : ${rule.from.join(' ou ')})`);
      }
      await this.audit.record(
        { actorId: admin.id, actorRole: 'ADMIN', action: `venue.${decision}`, entityType: 'Venue', entityId: id, before: { status: venue.status }, after: { status: rule.to, reason } },
        ctx,
        tx,
      );
    });

    const type = decision === 'reject' ? 'VENUE_REJECTED' : decision === 'suspend' ? 'VENUE_SUSPENDED' : 'VENUE_APPROVED';
    const managers = await this.prisma.venueStaff.findMany({ where: { venueId: id, role: { in: ['OWNER', 'MANAGER'] } }, select: { userId: true } });
    await this.notifications.notifyMany(managers.map((m) => m.userId), type, { venueId: id, venueName: venue.name, reason });
    return this.get(id);
  }

  /** Acompte propre à un complexe (les gérants ne le modifient pas eux-mêmes) ; `null` : règle par défaut de la plateforme. */
  async setDepositPolicy(admin: AuthUser, id: string, input: SetVenueDepositPolicyInput, ctx: RequestContext): Promise<AdminVenueView> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.venue.findUnique({ where: { id }, select: { depositPolicy: true } });
      if (!before) throw Errors.notFound('Complexe introuvable');
      await tx.venue.update({ where: { id }, data: { depositPolicy: input.depositPolicy === null ? Prisma.DbNull : input.depositPolicy } });
      await this.audit.record(
        { actorId: admin.id, actorRole: 'ADMIN', action: 'venue.deposit_policy', entityType: 'Venue', entityId: id, before: { depositPolicy: (before.depositPolicy ?? null) as Prisma.InputJsonValue }, after: { depositPolicy: input.depositPolicy } },
        ctx,
        tx,
      );
    });
    return this.get(id);
  }

  private toView(v: VenueRow, commission: AdminVenueView['commission'] | undefined): AdminVenueView {
    return {
      id: v.id,
      slug: v.slug,
      name: v.name,
      city: v.city,
      district: v.district,
      address: v.address,
      status: v.status,
      statusReason: v.statusReason,
      statusChangedAt: v.statusChangedAt?.toISOString() ?? null,
      fieldCount: v._count.fields,
      owners: v.staff.map((s) => ({ id: s.user.id, name: displayName(s.user), email: s.user.email, phone: s.user.phone })),
      depositPolicy: v.depositPolicy,
      commission: commission ?? { rateBps: 0, fixedMinor: 0, scope: 'GLOBAL' },
      ratingAvg: v.ratingAvg,
      ratingCount: v.ratingCount,
      createdAt: v.createdAt.toISOString(),
    };
  }
}
