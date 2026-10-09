import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, paramètres minimaux recommandés par l'OWASP (19 Mio, 2 itérations, 1 thread).
 * `algorithm: 2` = Argon2id (l'enum du paquet est un `const enum`, non importable avec isolatedModules).
 */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // Empreinte corrompue ou format inconnu : jamais de connexion.
      return false;
    }
  }

  /**
   * Vérifie le mot de passe contre une empreinte factice, pour qu'un email INCONNU prenne le même temps
   * qu'un email connu : sinon le temps de réponse révélerait quels comptes existent.
   */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('mot-de-passe-factice-pour-egaliser-les-temps');
    await this.verify(await this.dummyHash, password);
  }
}
