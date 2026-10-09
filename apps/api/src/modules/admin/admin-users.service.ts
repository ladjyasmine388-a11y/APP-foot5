import { HttpStatus, Injectable } from '@nestjs/common';
import { type AdminListUsersQuery, type AdminUserView, type BlockUserInput, type PageOf } from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { decodeOffset, encodeOffset } from '../teams/teams.service.js';

const userInclude = { stats: true } satisfies Prisma.UserInclude;
type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const conflict = (message: string): AppException => new AppException('CONFLICT', HttpStatus.CONFLICT, message);

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AdminListUsersQuery): Promise<PageOf<AdminUserView>> {
    const offset = decodeOffset(query.cursor);
    const q = query.q;
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { platformRole: query.role } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      include: userInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: query.limit + 1,
    });
    return {
      items: rows.slice(0, query.limit).map((u) => this.toView(u)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  async get(id: string): Promise<AdminUserView> {
    const row = await this.prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!row) throw Errors.notFound('Utilisateur introuvable');
    return this.toView(row);
  }

  /**
   * Bloque un compte : plus aucune requête n'aboutit (le garde relit le statut en base à chaque appel) et toutes ses
   * sessions sont révoquées. Un administrateur ne peut bloquer ni lui-même ni un autre administrateur.
   */
  async block(admin: AuthUser, id: string, input: BlockUserInput, ctx: RequestContext, now: Date = new Date()): Promise<AdminUserView> {
    if (id === admin.id) throw conflict('Vous ne pouvez pas bloquer votre propre compte');
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, select: { status: true, platformRole: true } });
      if (!user) throw Errors.notFound('Utilisateur introuvable');
      if (user.platformRole === 'ADMIN') throw conflict('Un administrateur ne peut pas être bloqué');
      const claimed = await tx.user.updateManyAndReturn({ where: { id, status: 'ACTIVE' }, data: { status: 'BLOCKED' }, select: { id: true } });
      if (claimed.length === 0) throw conflict(`Ce compte est déjà « ${user.status} »`);
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'blocked_by_admin' } });
      await this.audit.record(
        { actorId: admin.id, actorRole: 'ADMIN', action: 'user.block', entityType: 'User', entityId: id, before: { status: user.status }, after: { status: 'BLOCKED', reason: input.reason } },
        ctx,
        tx,
      );
    });
    return this.get(id);
  }

  async unblock(admin: AuthUser, id: string, ctx: RequestContext): Promise<AdminUserView> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, select: { status: true } });
      if (!user) throw Errors.notFound('Utilisateur introuvable');
      const claimed = await tx.user.updateManyAndReturn({ where: { id, status: 'BLOCKED' }, data: { status: 'ACTIVE' }, select: { id: true } });
      if (claimed.length === 0) throw conflict('Ce compte n’est pas bloqué');
      await this.audit.record({ actorId: admin.id, actorRole: 'ADMIN', action: 'user.unblock', entityType: 'User', entityId: id, before: { status: 'BLOCKED' }, after: { status: 'ACTIVE' } }, ctx, tx);
    });
    return this.get(id);
  }

  private toView(u: UserRow): AdminUserView {
    return {
      id: u.id,
      email: u.email,
      emailVerified: u.emailVerifiedAt !== null,
      phone: u.phone,
      firstName: u.firstName,
      lastName: u.lastName,
      city: u.city,
      platformRole: u.platformRole,
      status: u.status,
      matchesPlayed: u.stats?.matchesPlayed ?? 0,
      reliabilityScore: u.stats?.reliabilityScore ?? 100,
      noShowCount: u.stats?.noShowCount ?? 0,
      createdAt: u.createdAt.toISOString(),
    };
  }
}
