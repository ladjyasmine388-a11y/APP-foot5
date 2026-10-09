import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PasswordService } from '../../infra/security/password.service.js';
import { TokenService } from '../../infra/security/token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { RateLimitStore } from './rate-limit/rate-limit.store.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    RateLimitStore,
    // L'ordre compte : l'authentification d'abord (elle renseigne l'utilisateur), la limitation de débit ensuite.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [AuthService, PasswordService, TokenService, RateLimitStore],
})
export class AuthModule {}
