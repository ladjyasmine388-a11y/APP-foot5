import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AuthResponse,
  type ForgotPasswordInput,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@footfive/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../../common/errors/app-exception.js';
import { type RequestContext, ReqCtx } from '../../common/http/request-context.js';
import { ApiZodBody } from '../../common/zod/api-zod.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { ENV } from '../../infra/config/config.module.js';
import type { Env } from '../../infra/config/env.js';
import { toPublicUser } from '../users/user.mapper.js';
import { CurrentUser, Public } from './auth.decorators.js';
import {
  REFRESH_COOKIE,
  assertAllowedOrigin,
  clearRefreshCookie,
  isMobileClient,
  setRefreshCookie,
} from './auth.cookies.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
import { RateLimit } from './rate-limit/rate-limit.guard.js';

const HOUR = 3600;

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post('register')
  @RateLimit({ name: 'register', limit: 10, windowSeconds: HOUR, by: 'ip' })
  @ApiOperation({ summary: 'Créer un compte joueur et ouvrir une session' })
  @ApiZodBody(registerSchema)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @ReqCtx() ctx: RequestContext,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const session = await this.auth.register(body, ctx);
    return this.respond(session, request, reply);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit(
    // 5 essais par 15 min pour un couple IP + email : freine le bourrage d'identifiants.
    { name: 'login', limit: 5, windowSeconds: 15 * 60, by: 'ip+email' },
    // Plafond par IP, pour limiter l'énumération d'emails depuis une même adresse.
    { name: 'login-ip', limit: 40, windowSeconds: 15 * 60, by: 'ip' },
  )
  @ApiOperation({ summary: 'Se connecter (email + mot de passe)' })
  @ApiZodBody(loginSchema)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @ReqCtx() ctx: RequestContext,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const session = await this.auth.login(body, ctx);
    return this.respond(session, request, reply);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 60, by: 'ip' })
  @ApiOperation({
    summary: 'Renouveler la session (rotation du refresh token)',
    description:
      'Web : le refresh token est lu dans le cookie httpOnly (en-tête Origin obligatoire). ' +
      'Mobile : le passer dans le corps (`refreshToken`).',
  })
  @ApiZodBody(refreshSchema)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @ReqCtx() ctx: RequestContext,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponse> {
    const { token, fromCookie } = this.readRefreshToken(body, request);
    if (!token) throw Errors.tokenInvalid();

    const session = await this.auth.refresh(token, ctx);
    if (fromCookie) {
      setRefreshCookie(reply, session.refreshToken, this.env);
      return this.toResponse(session);
    }
    return this.toResponse(session, session.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Se déconnecter (révoque la session courante)' })
  @ApiZodBody(refreshSchema)
  async logout(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const { token } = this.readRefreshToken(body, request);
    if (token) await this.auth.logout(token);
    clearRefreshCookie(reply);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Déconnecter tous les appareils' })
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logoutAll(user.id);
    clearRefreshCookie(reply);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  @RateLimit({ name: 'verify-email', limit: 20, windowSeconds: HOUR, by: 'ip' })
  @ApiOperation({ summary: 'Confirmer son adresse email avec le jeton reçu par email' })
  @ApiZodBody(verifyEmailSchema)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailInput,
  ): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  @ApiBearerAuth()
  @Post('resend-verification')
  @HttpCode(204)
  @RateLimit({ name: 'resend-verification', limit: 3, windowSeconds: HOUR, by: 'user' })
  @ApiOperation({ summary: 'Renvoyer l’email de vérification' })
  async resendVerification(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.resendVerification(user.id);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @RateLimit(
    { name: 'forgot', limit: 3, windowSeconds: HOUR, by: 'ip+email' },
    { name: 'forgot-ip', limit: 10, windowSeconds: HOUR, by: 'ip' },
  )
  @ApiOperation({
    summary: 'Demander un lien de réinitialisation du mot de passe',
    description: 'Répond toujours 202, que l’email existe ou non (pas d’énumération des comptes).',
  })
  @ApiZodBody(forgotPasswordSchema)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
  ): Promise<{ message: string }> {
    await this.auth.forgotPassword(body.email);
    return {
      message: 'Si un compte existe pour cet email, un lien de réinitialisation a été envoyé.',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @RateLimit({ name: 'reset-password', limit: 10, windowSeconds: HOUR, by: 'ip' })
  @ApiOperation({ summary: 'Choisir un nouveau mot de passe avec le jeton reçu par email' })
  @ApiZodBody(resetPasswordSchema)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, ctx);
  }

  // ───────────────────────── Aides ─────────────────────────

  /** Lit le refresh token : corps (mobile) en priorité, sinon cookie (web, avec contrôle d'origine). */
  private readRefreshToken(
    body: RefreshInput,
    request: FastifyRequest,
  ): { token: string | undefined; fromCookie: boolean } {
    if (body.refreshToken) return { token: body.refreshToken, fromCookie: false };
    const cookie = request.cookies?.[REFRESH_COOKIE];
    if (cookie) {
      assertAllowedOrigin(request, this.env);
      return { token: cookie, fromCookie: true };
    }
    return { token: undefined, fromCookie: false };
  }

  /** Mobile : refresh token dans le corps. Web : cookie httpOnly, jamais dans le corps. */
  private respond(
    session: IssuedSession,
    request: FastifyRequest,
    reply: FastifyReply,
  ): AuthResponse {
    if (isMobileClient(request)) return this.toResponse(session, session.refreshToken);
    setRefreshCookie(reply, session.refreshToken, this.env);
    return this.toResponse(session);
  }

  private toResponse(session: IssuedSession, refreshToken?: string): AuthResponse {
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: session.expiresIn,
      ...(refreshToken ? { refreshToken } : {}),
      user: toPublicUser(session.user),
    };
  }
}
