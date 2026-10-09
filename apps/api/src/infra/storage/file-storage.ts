import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Global, Injectable, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface StoredFile {
  data: Buffer;
  contentType: string;
}

/**
 * Abstraction du stockage de fichiers. Le métier ne connaît ni le disque ni S3 : l'adaptateur S3/MinIO se branchera
 * en écrivant une seconde implémentation de ce contrat, sans toucher aux routes d'envoi d'images.
 */
export abstract class FileStorage {
  abstract put(key: string, data: Buffer, contentType: string): Promise<void>;
  abstract get(key: string): Promise<StoredFile | null>;
  abstract delete(key: string): Promise<void>;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Clés générées par le serveur uniquement (UUID + extension) : aucune clé fournie par un client n'atteint le disque. */
export const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** Stockage sur le disque local : développement et déploiement à une seule instance. */
@Injectable()
export class LocalFileStorage extends FileStorage {
  private readonly root: string;

  constructor(directory: string) {
    super();
    this.root = resolve(directory);
  }

  private pathOf(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error('Clé de stockage invalide');
    return join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(this.root, { recursive: true });
    await writeFile(path, data, { flag: 'wx' }); // jamais d'écrasement d'un fichier existant
  }

  async get(key: string): Promise<StoredFile | null> {
    if (!STORAGE_KEY.test(key)) return null;
    try {
      const data = await readFile(this.pathOf(key));
      return { data, contentType: CONTENT_TYPE_BY_EXT[key.split('.').pop() ?? ''] ?? 'application/octet-stream' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: FileStorage,
      inject: [ENV],
      useFactory: (env: Env): FileStorage => {
        if (env.STORAGE_DRIVER === 's3') {
          // Démarrer en croyant stocker sur S3 alors que les fichiers iraient sur le disque serait pire que ne pas démarrer.
          throw new Error('STORAGE_DRIVER=s3 n’est pas encore implémenté : utilisez « local » (une seule instance).');
        }
        return new LocalFileStorage(env.STORAGE_LOCAL_DIR);
      },
    },
  ],
  exports: [FileStorage],
})
export class StorageModule {}
