import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import { type MailMessage, Mailer } from './mailer.js';

/** Ce dont `SmtpMailer` a besoin d'un transport : permet de le remplacer dans les tests sans réseau. */
export interface MailTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Retire les retours à la ligne d'un en-tête : aucune injection d'en-têtes possible via un nom d'équipe ou un sujet. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

/**
 * Envoi réel par SMTP. Une erreur de livraison est propagée à l'appelant, qui décide quoi en faire (les notifications
 * l'journalisent sans bloquer l'action de l'utilisateur ; l'inscription ne dépend jamais de la livraison).
 */
@Injectable()
export class SmtpMailer extends Mailer {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: oneLine(message.to),
      subject: oneLine(message.subject),
      text: message.text,
    });
  }
}

export function createSmtpMailer(env: Env): SmtpMailer {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // En production, jamais d'identifiants en clair : STARTTLS est exigé si la connexion n'est pas déjà chiffrée.
    requireTLS: env.NODE_ENV === 'production' && !env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return new SmtpMailer(transport, env.MAIL_FROM);
}
