import { Global, Module } from '@nestjs/common';
import { PoliciesService } from './policies.service.js';

@Global()
@Module({ providers: [PoliciesService], exports: [PoliciesService] })
export class PoliciesModule {}
