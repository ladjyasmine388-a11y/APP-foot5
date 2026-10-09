import { HttpStatus, Injectable } from '@nestjs/common';
import { type AddStaffInput, type StaffMemberView, type UpdateStaffInput } from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PG_ERROR, isPgError } from '../../infra/database/pg-errors.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PoliciesService } from '../policies/policies.service.js';
import { displayName } from '../teams/teams.service.js';

const conflict = (code: 'CONFLICT' | 'ALREADY_JOINED', message: string): AppException => new AppException(code, HttpStatus.CONFLICT, message);

/**
 * Personnel d'un complexe. Lister : gérant ; ajouter, changer un rôle, retirer : propriétaire (chacun peut quitter le
 * complexe de lui-même). Un complexe garde TOUJOURS au moins un propriétaire, sinon plus personne ne pourrait le gérer.
 */
@Injectable()
export class VenueStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, venueId: string): Promise<StaffMemberView[]> {
    await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const rows = await this.prisma.venueStaff.findMany({
      where: { venueId },
      include: { user: { select: { firstName: true, lastName: true, email: true, status: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }], // propriétaires d'abord (ordre de déclaration de l'énumération)
    });
    return rows.map((r) => this.toView(r));
  }

  async add(user: AuthUser, venueId: string, input: AddStaffInput, ctx: RequestContext): Promise<StaffMemberView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'OWNER');
    const target = await this.prisma.user.findFirst({ where: { email: input.email, status: 'ACTIVE' }, select: { id: true } });
    if (!target) throw Errors.notFound('Aucun compte actif avec cette adresse email');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.venueStaff.create({
          data: { venueId, userId: target.id, role: input.role },
          include: { user: { select: { firstName: true, lastName: true, email: true, status: true } } },
        });
        await this.audit.record({ actorId: user.id, actorRole: access.role, action: 'venue.staff_add', entityType: 'Venue', entityId: venueId, after: { userId: target.id, role: input.role } }, ctx, tx);
        return created;
      });
      return this.toView(row);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) throw conflict('ALREADY_JOINED', 'Cette personne fait déjà partie du personnel');
      throw error;
    }
  }

  async updateRole(user: AuthUser, venueId: string, targetId: string, input: UpdateStaffInput, ctx: RequestContext): Promise<StaffMemberView> {
    const access = await this.policies.requireVenueRole(user, venueId, 'OWNER');
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockVenue(tx, venueId);
      const current = await tx.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: targetId } } });
      if (!current) throw Errors.notFound('Cette personne ne fait pas partie du personnel');
      if (current.role === 'OWNER' && input.role !== 'OWNER') await this.requireAnotherOwner(tx, venueId);
      const updated = await tx.venueStaff.update({
        where: { id: current.id },
        data: { role: input.role },
        include: { user: { select: { firstName: true, lastName: true, email: true, status: true } } },
      });
      await this.audit.record({ actorId: user.id, actorRole: access.role, action: 'venue.staff_role', entityType: 'Venue', entityId: venueId, before: { userId: targetId, role: current.role }, after: { userId: targetId, role: input.role } }, ctx, tx);
      return updated;
    });
    return this.toView(row);
  }

  /** Un propriétaire retire n'importe qui ; chacun peut se retirer lui-même. */
  async remove(user: AuthUser, venueId: string, targetId: string, ctx: RequestContext): Promise<void> {
    const access = await this.policies.requireVenueRole(user, venueId, targetId === user.id ? 'STAFF' : 'OWNER');
    await this.prisma.$transaction(async (tx) => {
      await this.lockVenue(tx, venueId);
      const current = await tx.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: targetId } } });
      if (!current) throw Errors.notFound('Cette personne ne fait pas partie du personnel');
      if (current.role === 'OWNER') await this.requireAnotherOwner(tx, venueId);
      await tx.venueStaff.delete({ where: { id: current.id } });
      await this.audit.record({ actorId: user.id, actorRole: access.role, action: 'venue.staff_remove', entityType: 'Venue', entityId: venueId, before: { userId: targetId, role: current.role } }, ctx, tx);
    });
  }

  /** Les changements de personnel d'un même complexe s'exécutent l'un après l'autre (sinon deux départs simultanés videraient les propriétaires). */
  private async lockVenue(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${venueId}::uuid FOR UPDATE`;
  }

  private async requireAnotherOwner(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
    const owners = await tx.venueStaff.count({ where: { venueId, role: 'OWNER' } });
    if (owners <= 1) throw conflict('CONFLICT', 'Un complexe doit garder au moins un propriétaire : nommez-en un autre d’abord');
  }

  private toView(r: { userId: string; role: 'OWNER' | 'MANAGER' | 'STAFF'; createdAt: Date; user: { firstName: string; lastName: string; email: string; status: string } }): StaffMemberView {
    return { userId: r.userId, name: displayName(r.user), email: r.user.email, role: r.role, createdAt: r.createdAt.toISOString() };
  }
}
