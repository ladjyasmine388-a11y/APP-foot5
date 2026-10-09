import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ConsoleMailer, Mailer } from './mailer.js';
import { createSmtpMailer } from './smtp-mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ENV],
      useFactory: (env: Env): Mailer => {
        if (env.MAIL_DRIVER === 'smtp') return createSmtpMailer(env);
        return new ConsoleMailer();
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
