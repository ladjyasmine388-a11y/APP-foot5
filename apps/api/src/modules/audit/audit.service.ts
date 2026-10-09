import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';

export interface AuditEntry {
  actorId?: string | null;
  /** "USER", "ADMIN", "VENUE_OWNER", "SYSTEM"… */
  actorRole: string;
  /** Verbe stable, ex. "auth.password_reset", "user.delete", "commission.update". */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** États avant/après d'une modification. NE JAMAIS y mettre de mot de passe, jeton ni donnée sensible. */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

/**
 * Journal d'audit des actions sensibles (INSERT uniquement : un trigger SQL interdit toute modification).
 * Accepte un client de transaction : l'action et sa trace sont enregistrées ENSEMBLE ou pas du tout.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    entry: AuditEntry,
    ctx?: RequestContext,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before,
        after: entry.after,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
        requestId: ctx?.requestId,
      },
    });
  }
}
