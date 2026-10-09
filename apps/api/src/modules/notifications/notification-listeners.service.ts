import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NotificationType } from '@footfive/shared';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { DomainEvents } from '../../infra/events/domain-events.js';
import { displayName } from '../teams/teams.service.js';
import type { NotificationData } from './notification-content.js';
import { NotificationsService } from './notifications.service.js';

const person = { firstName: true, lastName: true, status: true } as const;

/**
 * Traduit les événements métier en notifications. Chaque écouteur relit les données dont il a besoin (l'événement ne
 * porte que des identifiants) et ne transmet que des libellés d'affichage : jamais d'email ni de téléphone.
 * Une erreur est journalisée par le bus d'événements et ne remet jamais en cause l'action de l'utilisateur.
 */
@Injectable()
export class NotificationListenersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    const on = this.events.on.bind(this.events);

    // Réservations et paiements
    on('booking.confirmed', ({ bookingId }) => this.booking(bookingId, 'BOOKING_CONFIRMED'));
    on('booking.cancelled', ({ bookingId }) => this.booking(bookingId, 'BOOKING_CANCELLED'));
    on('booking.expired', async ({ bookingIds }) => {
      for (const id of bookingIds) await this.booking(id, 'BOOKING_EXPIRED');
    });
    on('refund.processed', ({ refundId }) => this.refund(refundId));

    // Équipes
    on('team.invitation_created', ({ invitationId }) => this.invitation(invitationId));
    on('team.invitation_accepted', ({ teamId, userId }) => this.invitationAccepted(teamId, userId));

    // Sessions « Complétez votre équipe »
    on('solo.player_joined', ({ sessionId, remaining }) => this.soloAlmostFull(sessionId, remaining));
    on('solo.full', ({ sessionId }) => this.soloFull(sessionId));
    on('solo.cancelled', ({ sessionId, playerIds }) => this.soloCancelled(sessionId, playerIds));

    // Adversaires et matchs
    on('opponent.request_created', ({ requestId }) => this.requestReceived(requestId));
    on('opponent.request_accepted', ({ requestId, matchId }) => this.requestAccepted(requestId, matchId));
    on('opponent.request_rejected', ({ requestId }) => this.requestRejected(requestId));
    on('match.cancelled', (payload) => this.matchCancelled(payload));
  }

  // ───────────────────────── Réservations ─────────────────────────

  private async booking(bookingId: string, type: Extract<NotificationType, 'BOOKING_CONFIRMED' | 'BOOKING_CANCELLED' | 'BOOKING_EXPIRED'>): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, reference: true, userId: true, startsAt: true, bookingType: true, venue: { select: { name: true } } },
    });
    if (!booking?.userId || booking.bookingType === 'BLOCK') return; // réservation manuelle sans compte : rien à notifier
    await this.notifications.notify(booking.userId, type, {
      bookingId: booking.id,
      reference: booking.reference,
      venueName: booking.venue.name,
      startsAt: booking.startsAt.toISOString(),
    });
  }

  private async refund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { amountMinor: true, booking: { select: { id: true, reference: true, userId: true } } },
    });
    if (!refund?.booking.userId) return;
    await this.notifications.notify(refund.booking.userId, 'REFUND_PROCESSED', {
      bookingId: refund.booking.id,
      reference: refund.booking.reference,
      amountMinor: refund.amountMinor,
    });
  }

  // ───────────────────────── Équipes ─────────────────────────

  private async invitation(invitationId: string): Promise<void> {
    const inv = await this.prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      select: { inviteeId: true, teamId: true, team: { select: { name: true } }, inviter: { select: person } },
    });
    if (!inv?.inviteeId) return; // invité par email sans compte : il a reçu un email d'invitation
    await this.notifications.notify(inv.inviteeId, 'TEAM_INVITATION_RECEIVED', {
      invitationId,
      teamId: inv.teamId,
      teamName: inv.team.name,
      invitedBy: displayName(inv.inviter),
    });
  }

  private async invitationAccepted(teamId: string, userId: string): Promise<void> {
    const [team, player] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: teamId }, select: { name: true, captainId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: person }),
    ]);
    if (!team || !player || team.captainId === userId) return;
    await this.notifications.notify(team.captainId, 'TEAM_INVITATION_ACCEPTED', { teamId, teamName: team.name, playerName: displayName(player) });
  }

  // ───────────────────────── Sessions ─────────────────────────

  private async soloContext(sessionId: string) {
    return this.prisma.soloSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        origin: true,
        createdById: true,
        startsAt: true,
        venue: { select: { name: true } },
        players: { where: { status: 'JOINED' }, select: { userId: true } },
      },
    });
  }

  private soloData(s: NonNullable<Awaited<ReturnType<NotificationListenersService['soloContext']>>>): NotificationData {
    return { sessionId: s.id, venueName: s.venue.name, startsAt: s.startsAt.toISOString() };
  }

  /** Prévient l'hôte quand il ne reste plus que 1 ou 2 places. */
  private async soloAlmostFull(sessionId: string, remaining: number): Promise<void> {
    if (remaining < 1 || remaining > 2) return;
    const s = await this.soloContext(sessionId);
    if (!s || s.origin !== 'PLAYER') return;
    await this.notifications.notify(s.createdById, 'SOLO_ALMOST_FULL', { ...this.soloData(s), remaining });
  }

  private async soloFull(sessionId: string): Promise<void> {
    const s = await this.soloContext(sessionId);
    if (!s) return;
    const recipients = s.players.map((p) => p.userId);
    if (s.origin === 'PLAYER') recipients.push(s.createdById);
    await this.notifications.notifyMany(recipients, 'SOLO_FULL', this.soloData(s));
  }

  private async soloCancelled(sessionId: string, playerIds: string[]): Promise<void> {
    const s = await this.soloContext(sessionId);
    if (!s) return;
    const recipients = [...playerIds];
    if (s.origin === 'PLAYER') recipients.push(s.createdById);
    await this.notifications.notifyMany(recipients, 'SOLO_CANCELLED', this.soloData(s));
  }

  // ───────────────────────── Adversaires et matchs ─────────────────────────

  private async requestContext(requestId: string) {
    return this.prisma.matchRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        listingId: true,
        requestedById: true,
        requestingTeam: { select: { name: true, captainId: true } },
        listing: { select: { startsAt: true, team: { select: { name: true, captainId: true } }, venue: { select: { name: true } } } },
      },
    });
  }

  private async requestReceived(requestId: string): Promise<void> {
    const r = await this.requestContext(requestId);
    if (!r) return;
    await this.notifications.notify(r.listing.team.captainId, 'OPPONENT_REQUEST_RECEIVED', {
      listingId: r.listingId,
      requestId,
      teamName: r.requestingTeam.name,
      venueName: r.listing.venue.name,
      startsAt: r.listing.startsAt.toISOString(),
    });
  }

  private async requestAccepted(requestId: string, matchId: string): Promise<void> {
    const r = await this.requestContext(requestId);
    if (!r) return;
    await this.notifications.notifyMany([r.requestedById, r.requestingTeam.captainId], 'OPPONENT_ACCEPTED', {
      listingId: r.listingId,
      matchId,
      teamName: r.listing.team.name,
      venueName: r.listing.venue.name,
      startsAt: r.listing.startsAt.toISOString(),
    });
  }

  private async requestRejected(requestId: string): Promise<void> {
    const r = await this.requestContext(requestId);
    if (!r) return;
    await this.notifications.notify(r.requestedById, 'OPPONENT_REJECTED', {
      listingId: r.listingId,
      venueName: r.listing.venue.name,
      startsAt: r.listing.startsAt.toISOString(),
    });
  }

  private async matchCancelled(payload: { matchId: string; participantIds: string[]; venueName?: string; startsAt?: string }): Promise<void> {
    let { venueName, startsAt } = payload;
    if (!venueName || !startsAt) {
      const match = await this.prisma.match.findUnique({ where: { id: payload.matchId }, select: { startsAt: true, venue: { select: { name: true } } } });
      if (!match) return;
      venueName = match.venue.name;
      startsAt = match.startsAt.toISOString();
    }
    await this.notifications.notifyMany(payload.participantIds, 'MATCH_CANCELLED', { matchId: payload.matchId, venueName, startsAt });
  }
}
