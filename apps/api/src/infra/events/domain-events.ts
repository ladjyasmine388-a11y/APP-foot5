import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Événements métier internes. Ils servent à déclencher des EFFETS DE BORD (appel au prestataire de paiement,
 * notifications…) APRÈS la validation d'une transaction : on n'appelle jamais un service externe pendant qu'une
 * transaction de base de données est ouverte.
 *
 * Contrat : l'émetteur a DÉJÀ enregistré l'état définitif en base. Un auditeur qui échoue est journalisé mais ne
 * remet jamais en cause l'action de l'utilisateur ; tout ce qui doit être garanti est rattrapé par la maintenance
 * périodique (ex. un remboursement resté « demandé » est retraité).
 */
export interface DomainEventMap {
  'booking.confirmed': { bookingId: string };
  'booking.cancelled': { bookingId: string; by: 'PLAYER' | 'VENUE' | 'SYSTEM' };
  'booking.expired': { bookingIds: string[] };
  'refund.requested': { refundIds: string[] };
}

export type DomainEventName = keyof DomainEventMap;
type Handler<K extends DomainEventName> = (payload: DomainEventMap[K]) => Promise<void> | void;

@Injectable()
export class DomainEvents {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers = new Map<DomainEventName, Handler<DomainEventName>[]>();

  on<K extends DomainEventName>(event: K, handler: Handler<K>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<DomainEventName>);
    this.handlers.set(event, list);
  }

  /** Exécute les auditeurs un par un ; une erreur est journalisée, jamais propagée à l'émetteur. */
  async emit<K extends DomainEventName>(event: K, payload: DomainEventMap[K]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        await handler(payload);
      } catch (error) {
        this.logger.error(
          `Auditeur en échec pour « ${event} »`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}

@Global()
@Module({ providers: [DomainEvents], exports: [DomainEvents] })
export class EventsModule {}
