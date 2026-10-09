import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type UploadedImage, UPLOAD_CONTENT_TYPES } from '@footfive/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { STORAGE_KEY } from '../../infra/storage/file-storage.js';
import { CurrentUser, Public } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RateLimit } from '../auth/rate-limit/rate-limit.guard.js';
import { UploadsService } from './uploads.service.js';

const uuid = new ZodValidationPipe(z.uuid());
const fileKey = new ZodValidationPipe(z.string().regex(STORAGE_KEY));
const uploadRate = { name: 'upload', limit: 30, windowSeconds: 3600, by: 'user' } as const;
const imageBody = { description: 'Image JPEG, PNG ou WebP (2 Mo maximum), envoyée telle quelle dans le corps', schema: { type: 'string', format: 'binary' } } as const;

@ApiTags('Images')
@ApiBearerAuth()
@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** Les noms sont des UUID aléatoires et le contenu ne change jamais : cache navigateur/CDN illimité. */
  @Get('uploads/:key')
  @Public()
  @RateLimit({ name: 'public-browse', limit: 300, windowSeconds: 60, by: 'ip' })
  @ApiOperation({ summary: 'Image envoyée (avatar, logo d’équipe, photo de complexe)' })
  async read(@Param('key', fileKey) key: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<StreamableFile> {
    const file = await this.uploads.read(key);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin'); // le site web, sur une autre origine, affiche ces images
    return new StreamableFile(file.data, { type: file.contentType });
  }

  @Put('me/avatar')
  @RateLimit(uploadRate)
  @ApiOperation({ summary: 'Définir ma photo de profil' })
  @ApiConsumes(...UPLOAD_CONTENT_TYPES)
  @ApiBody(imageBody)
  setAvatar(@CurrentUser() user: AuthUser, @Body() body: unknown, @Headers('content-type') contentType: string | undefined): Promise<UploadedImage> {
    return this.uploads.setAvatar(user, body, contentType);
  }

  @Delete('me/avatar')
  @HttpCode(204)
  @ApiOperation({ summary: 'Supprimer ma photo de profil' })
  async removeAvatar(@CurrentUser() user: AuthUser): Promise<void> {
    await this.uploads.removeAvatar(user);
  }

  @Put('teams/:teamId/logo')
  @RateLimit(uploadRate)
  @ApiOperation({ summary: 'Définir le logo de mon équipe (capitaine)' })
  @ApiConsumes(...UPLOAD_CONTENT_TYPES)
  @ApiBody(imageBody)
  setLogo(
    @CurrentUser() user: AuthUser,
    @Param('teamId', uuid) teamId: string,
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UploadedImage> {
    return this.uploads.setTeamLogo(user, teamId, body, contentType, ctx);
  }

  @Delete('teams/:teamId/logo')
  @HttpCode(204)
  @ApiOperation({ summary: 'Supprimer le logo de mon équipe (capitaine)' })
  async removeLogo(@CurrentUser() user: AuthUser, @Param('teamId', uuid) teamId: string): Promise<void> {
    await this.uploads.removeTeamLogo(user, teamId);
  }

  @Post('manage/venues/:venueId/photos')
  @RateLimit(uploadRate)
  @ApiOperation({ summary: 'Ajouter une photo au complexe (gérant) — 10 maximum' })
  @ApiConsumes(...UPLOAD_CONTENT_TYPES)
  @ApiBody(imageBody)
  addPhoto(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @ReqCtx() ctx: RequestContext,
  ): Promise<UploadedImage> {
    return this.uploads.addVenuePhoto(user, venueId, body, contentType, ctx);
  }

  @Delete('manage/venues/:venueId/photos/:key')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retirer une photo du complexe (gérant)' })
  async removePhoto(
    @CurrentUser() user: AuthUser,
    @Param('venueId', uuid) venueId: string,
    @Param('key', fileKey) key: string,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.uploads.removeVenuePhoto(user, venueId, key, ctx);
  }
}
