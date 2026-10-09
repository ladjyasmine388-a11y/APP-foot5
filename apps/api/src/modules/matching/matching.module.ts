import { Global, Module } from '@nestjs/common';
import { MatchingStrategy, SimpleCriteriaStrategy } from './matching.strategy.js';

/** Pour changer d'algorithme de mise en relation : remplacer `SimpleCriteriaStrategy` ci-dessous. */
@Global()
@Module({
  providers: [{ provide: MatchingStrategy, useClass: SimpleCriteriaStrategy }],
  exports: [MatchingStrategy],
})
export class MatchingModule {}
