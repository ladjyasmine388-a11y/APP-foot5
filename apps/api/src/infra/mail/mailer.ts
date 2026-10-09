import { Injectable, Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Abstraction d'envoi d'email : le métier ne connaît ni SMTP ni aucun prestataire.
 * Implémentations : ConsoleMailer (dev/test) ; SmtpMailer (étape 8, notifications).
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Écrit l'email dans les journaux au lieu de l'envoyer. Pratique en développement (le lien de vérification
 * s'affiche dans la console) ; INTERDIT en production par la validation de l'environnement,
 * car les journaux contiendraient des liens secrets.
 */
@Injectable()
export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  send(message: MailMessage): Promise<void> {
    this.logger.log(`✉  À : ${message.to}\n   Objet : ${message.subject}\n${message.text}`);
    return Promise.resolve();
  }
}
