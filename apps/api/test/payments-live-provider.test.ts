import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

/**
 * Tant qu'aucun adaptateur CIB / Edahabia n'est branché, demander le prestataire « réel » doit FAIRE ÉCHOUER le
 * démarrage : mieux vaut un serveur qui refuse de démarrer qu'un serveur qui accepterait des réservations sans pouvoir
 * jamais encaisser (ou, pire, qui retomberait silencieusement sur le prestataire simulé).
 */
describe('prestataire de paiement « réel » non branché', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env['PAYMENT_PROVIDER'];
    process.env['PAYMENT_PROVIDER'] = 'live';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['PAYMENT_PROVIDER'];
    else process.env['PAYMENT_PROVIDER'] = previous;
  });

  it('le démarrage échoue avec un message explicite', async () => {
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
      /aucun adaptateur de paiement réel/,
    );
  });
});
