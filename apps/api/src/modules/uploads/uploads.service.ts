import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type UploadedImage,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_MAX_BYTES,
  VENUE_MAX_PHOTOS,
} from '@footfive/shared';
import { API_PREFIX } from '../../app.setup.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { FileStorage, STORAGE_KEY } from '../../infra/storage/file-storage.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PoliciesService } from '../policies/policies.service.js';
import { TeamsService } from '../teams/teams.service.js';
import { EXTENSION, InvalidImageError, sniffImage, stripMetadata } from './image-sniff.js';

const invalid = (message: string): AppException =>
  new AppException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, message);

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly policies: PoliciesService,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    const origin = (env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT}`).replace(/\/+$/, '');
    this.base = `${origin}/${API_PREFIX}/uploads/`;
  }

  // ───────────────────────── Lecture publique ─────────────────────────

  async read(key: string): Promise<{ data: Buffer; contentType: string }> {
    const file = STORAGE_KEY.test(key) ? await this.storage.get(key) : null;
    if (!file) throw Errors.notFound('Fichier introuvable');
    return file;
  }

  // ───────────────────────── Images ─────────────────────────

  /**
   * Valide et enregistre une image : taille bornée, VRAI format déterminé sur les octets (et cohérent avec l'en-tête),
   * métadonnées retirées, nom généré par le serveur. Rien de ce que le client choisit n'atteint le système de fichiers.
   */
  private async saveImage(
    body: unknown,
    contentTypeHeader: string | undefined,
  ): Promise<{ key: string; url: string }> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw invalid(
        `Envoyez l’image en corps binaire (Content-Type : ${UPLOAD_CONTENT_TYPES.join(', ')})`,
      );
    }
    if (body.length > UPLOAD_MAX_BYTES) {
      throw new AppException(
        'VALIDATION_ERROR',
        HttpStatus.PAYLOAD_TOO_LARGE,
        `Image trop volumineuse (${UPLOAD_MAX_BYTES / 1024 / 1024} Mo maximum)`,
      );
    }
    const declared = (contentTypeHeader ?? '').split(';')[0]?.trim().toLowerCase();
    const real = sniffImage(body);
    if (!real || real !== declared)
      throw invalid('Format d’image invalide ou non supporté (JPEG, PNG ou WebP)');

    let clean: Buffer;
    try {
      clean = stripMetadata(body, real);
    } catch (error) {
      if (error instanceof InvalidImageError) throw invalid(`Image corrompue : ${error.message}`);
      throw error;
    }
    const key = `${randomUUID()}.${EXTENSION[real]}`;
    await this.storage.put(key, clean, real);
    return { key, url: this.base + key };
  }

  /** Supprime un fichier que NOUS avons stocké (jamais une URL externe). Sans effet s'il n'existe plus. */
  private async discard(url: string | null | undefined): Promise<void> {
    if (!url?.startsWith(this.base)) return;
    const key = url.slice(this.base.length);
    if (!STORAGE_KEY.test(key)) return;
    await this.storage
      .delete(key)
      .catch((error: unknown) =>
        this.logger.warn(`Suppression de ${key} impossible : ${String(error)}`),
      );
  }

  async setAvatar(
    user: AuthUser,
    body: unknown,
    contentType: string | undefined,
  ): Promise<UploadedImage> {
    const saved = await this.saveImage(body, contentType);
    const previous = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { avatarUrl: saved.url } });
    await this.discard(previous.avatarUrl);
    return { url: saved.url };
  }

  async removeAvatar(user: AuthUser): Promise<void> {
    const previous = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
    await this.discard(previous.avatarUrl);
  }

  async setTeamLogo(
    user: AuthUser,
    teamId: string,
    body: unknown,
    contentType: string | undefined,
    ctx: RequestContext,
  ): Promise<UploadedImage> {
    await this.teams.requireCaptain(user.id, teamId); // vérifié AVANT d'accepter le moindre octet
    const saved = await this.saveImage(body, contentType);
    const previous = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { logoUrl: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.team.update({ where: { id: teamId }, data: { logoUrl: saved.url } });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: 'USER',
          action: 'team.logo_set',
          entityType: 'Team',
          entityId: teamId,
        },
        ctx,
        tx,
      );
    });
    await this.discard(previous.logoUrl);
    return { url: saved.url };
  }

  async removeTeamLogo(user: AuthUser, teamId: string): Promise<void> {
    await this.teams.requireCaptain(user.id, teamId);
    const previous = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { logoUrl: true },
    });
    await this.prisma.team.update({ where: { id: teamId }, data: { logoUrl: null } });
    await this.discard(previous.logoUrl);
  }

  async addVenuePhoto(
    user: AuthUser,
    venueId: string,
    body: unknown,
    contentType: string | undefined,
    ctx: RequestContext,
  ): Promise<UploadedImage> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER'); // avant d'accepter le moindre octet
    const saved = await this.saveImage(body, contentType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${venueId}::uuid FOR UPDATE`;
        const venue = await tx.venue.findUniqueOrThrow({
          where: { id: venueId },
          select: { photos: true },
        });
        if (venue.photos.length >= VENUE_MAX_PHOTOS) {
          throw new AppException(
            'CONFLICT',
            HttpStatus.CONFLICT,
            `Un complexe peut avoir ${VENUE_MAX_PHOTOS} photos au maximum`,
          );
        }
        await tx.venue.update({
          where: { id: venueId },
          data: { photos: [...venue.photos, saved.url] },
        });
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: access.role,
            action: 'venue.photo_add',
            entityType: 'Venue',
            entityId: venueId,
          },
          ctx,
          tx,
        );
      });
    } catch (error) {
      await this.discard(saved.url); // l'image n'a été rattachée à rien
      throw error;
    }
    return { url: saved.url };
  }

  async removeVenuePhoto(
    user: AuthUser,
    venueId: string,
    key: string,
    ctx: RequestContext,
  ): Promise<void> {
    const access = await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const url = this.base + key;
    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Venue" WHERE "id" = ${venueId}::uuid FOR UPDATE`;
      const venue = await tx.venue.findUniqueOrThrow({
        where: { id: venueId },
        select: { photos: true },
      });
      if (!venue.photos.includes(url)) return false;
      await tx.venue.update({
        where: { id: venueId },
        data: { photos: venue.photos.filter((p) => p !== url) },
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: access.role,
          action: 'venue.photo_remove',
          entityType: 'Venue',
          entityId: venueId,
        },
        ctx,
        tx,
      );
      return true;
    });
    if (!removed) throw Errors.notFound('Photo introuvable');
    await this.discard(url);
  }
}
