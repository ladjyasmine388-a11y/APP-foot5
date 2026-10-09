import { Injectable } from '@nestjs/common';
import type { VenueStaffRole } from '@footfive/shared';
import { Errors } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import type { AuthUser } from '../auth/auth.types.js';

const RANK: Record<VenueStaffRole, number> = { STAFF: 1, MANAGER: 2, OWNER: 3 };

export interface VenueAccess {
  /** Rôle effectif dans ce complexe ; `ADMIN` = administrateur de la plateforme (accès à tous les complexes). */
  role: VenueStaffRole | 'ADMIN';
}

/**
 * Autorisations CONTEXTUELLES : « cet utilisateur peut-il agir sur CE complexe / CETTE équipe ? ».
 * Appelé par les SERVICES (pas seulement par des gardes) : une règle d'accès oubliée dans un contrôleur
 * ne peut pas exposer les données d'un autre complexe.
 */
@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exige au moins le rôle `min` dans le complexe.
   *  - non-membre → 404 (on ne confirme même pas que ce complexe existe) ;
   *  - membre au rôle insuffisant → 403 ;
   *  - administrateur de la plateforme → toujours autorisé.
   */
  async requireVenueRole(
    user: AuthUser,
    venueId: string,
    min: VenueStaffRole,
  ): Promise<VenueAccess> {
    if (user.platformRole === 'ADMIN') {
      const exists = await this.prisma.venue.findUnique({
        where: { id: venueId },
        select: { id: true },
      });
      if (!exists) throw Errors.notFound('Complexe introuvable');
      return { role: 'ADMIN' };
    }

    const membership = await this.prisma.venueStaff.findUnique({
      where: { venueId_userId: { venueId, userId: user.id } },
      select: { role: true },
    });
    if (!membership) throw Errors.notFound('Complexe introuvable');
    if (RANK[membership.role] < RANK[min])
      throw Errors.forbidden('Droits insuffisants pour cette action');
    return { role: membership.role };
  }
}
