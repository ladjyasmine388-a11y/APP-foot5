import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';

/** Jeton d'injection de la configuration validée. */
export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
