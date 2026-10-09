import { describe, expect, it } from 'vitest';
import { type MailTransport, SmtpMailer } from './smtp-mailer.js';

describe('SmtpMailer', () => {
  it('transmet destinataire, sujet et texte avec l’expéditeur configuré', async () => {
    const sent: Parameters<MailTransport['sendMail']>[0][] = [];
    const mailer = new SmtpMailer(
      { sendMail: (o) => (sent.push(o), Promise.resolve()) },
      'Foot Five <no-reply@example.com>',
    );
    await mailer.send({ to: 'joueur@example.com', subject: 'Bonjour', text: 'Corps du message' });
    expect(sent).toEqual([
      {
        from: 'Foot Five <no-reply@example.com>',
        to: 'joueur@example.com',
        subject: 'Bonjour',
        text: 'Corps du message',
      },
    ]);
  });

  it('neutralise les retours à la ligne : aucune injection d’en-têtes par un nom d’équipe ou une adresse', async () => {
    const sent: Parameters<MailTransport['sendMail']>[0][] = [];
    const mailer = new SmtpMailer({ sendMail: (o) => (sent.push(o), Promise.resolve()) }, 'a@b.co');
    await mailer.send({
      to: 'x@y.co\r\nBcc: pirate@evil.example',
      subject: 'Équipe\r\nBcc: pirate@evil.example',
      text: 't',
    });
    expect(sent[0]?.subject).not.toMatch(/[\r\n]/);
    expect(sent[0]?.to).not.toMatch(/[\r\n]/);
  });

  it('propage l’échec de livraison à l’appelant', async () => {
    const mailer = new SmtpMailer(
      { sendMail: () => Promise.reject(new Error('connexion refusée')) },
      'a@b.co',
    );
    await expect(mailer.send({ to: 'x@y.co', subject: 's', text: 't' })).rejects.toThrow(
      'connexion refusée',
    );
  });
});
