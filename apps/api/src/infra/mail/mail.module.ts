import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ConsoleMailer, Mailer } from './mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [ENV],
      useFactory: (env: Env): Mailer => {
        if (env.MAIL_DRIVER === 'smtp') {
          // Démarrer sans transport d'email réel serait pire que ne pas démarrer : les utilisateurs
          // ne recevraient jamais leurs liens de vérification.
          throw new Error(
            'MAIL_DRIVER=smtp n’est pas encore implémenté (prévu à l’étape 8 : notifications).',
          );
        }
        return new ConsoleMailer();
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
