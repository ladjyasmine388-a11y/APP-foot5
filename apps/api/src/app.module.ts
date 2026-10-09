import { Module } from '@nestjs/common';
import { ConfigModule } from './infra/config/config.module.js';
import { PrismaModule } from './infra/database/prisma.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule],
})
export class AppModule {}
