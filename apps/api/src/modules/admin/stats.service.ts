import { Injectable } from '@nestjs/common';
import { type AdminStats, type DailyPoint, type PlayerStats, type StatsQuery, type VenueStats } from '@footfive/shared';
import { Errors } from '../../common/errors/app-exception.js';
import { addDays, localToUtc } from '../../common/time/zoned-time.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PLATFORM_TZ } from '../matches/social-common.js';
import { PoliciesService } from '../policies/policies.service.js';

/** Une réservation compte dans le chiffre d'affaires dès qu'elle est confirmée ou jouée (jamais annulée, expirée ou en attente). */
const COUNTED = ['CONFIRMED', 'COMPLETED'] as const;

type Range = { from: string; to: string; start: Date; end: Date; tz: string };
const rangeOf = (query: StatsQuery, tz: string): Range => ({
  ...query,
  tz,
  start: localToUtc(query.from, 0, tz),
  end: localToUtc(query.to, 1440, tz), // fin du dernier jour de service inclus
});

const num = (value: bigint | number | null | undefined): number => Number(value ?? 0);

/** Une valeur par jour de la période, y compris les jours sans réservation. */
function fillDays(range: Range, rows: { date: string; bookings: number; revenue: bigint | number }[]): DailyPoint[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DailyPoint[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const row = byDate.get(day);
    out.push({ date: day, bookings: num(row?.bookings), revenueMinor: num(row?.revenue) });
  }
  return out;
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
  ) {}

  // ───────────────────────── Administration ─────────────────────────

  async admin(query: StatsQuery, now: Date = new Date()): Promise<AdminStats> {
    const r = rangeOf(query, PLATFORM_TZ);
    const inRange = { startsAt: { gte: r.start, lt: r.end }, bookingType: 'STANDARD' as const };

    const [users, newUsers, blocked, venueGroups, bookingGroups, money, refunded, pendingRefunds, failedRefunds, scheduled, completed, daily, top] = await Promise.all([
      this.prisma.user.count({ where: { status: { not: 'DELETED' } } }),
      this.prisma.user.count({ where: { createdAt: { gte: r.start, lt: r.end } } }),
      this.prisma.user.count({ where: { status: 'BLOCKED' } }),
      this.prisma.venue.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['status'], where: inRange, _count: { _all: true } }),
      this.prisma.booking.aggregate({ where: { ...inRange, status: { in: [...COUNTED] } }, _sum: { basePriceMinor: true, commissionMinor: true } }),
      this.prisma.refund.aggregate({ where: { status: 'SUCCEEDED', processedAt: { gte: r.start, lt: r.end } }, _sum: { amountMinor: true } }),
      this.prisma.refund.count({ where: { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } } }),
      this.prisma.refund.count({ where: { status: 'FAILED' } }),
      this.prisma.match.count({ where: { status: 'SCHEDULED', startsAt: { gt: now } } }),
      this.prisma.match.count({ where: { status: 'COMPLETED', endsAt: { gte: r.start, lt: r.end } } }),
      this.prisma.$queryRaw<{ date: string; bookings: number; revenue: bigint }[]>`
        SELECT to_char(("startsAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS bookings, COALESCE(SUM("basePriceMinor"), 0)::bigint AS revenue
        FROM "Booking"
        WHERE "bookingType" = 'STANDARD' AND "status" IN ('CONFIRMED', 'COMPLETED') AND "startsAt" >= ${r.start} AND "startsAt" < ${r.end}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ venueId: string; name: string; bookings: number; gross: bigint }[]>`
        SELECT v."id" AS "venueId", v."name", COUNT(*)::int AS bookings, COALESCE(SUM(b."basePriceMinor"), 0)::bigint AS gross
        FROM "Booking" b JOIN "Venue" v ON v."id" = b."venueId"
        WHERE b."bookingType" = 'STANDARD' AND b."status" IN ('CONFIRMED', 'COMPLETED') AND b."startsAt" >= ${r.start} AND b."startsAt" < ${r.end}
        GROUP BY v."id", v."name" ORDER BY gross DESC, bookings DESC LIMIT 5`,
    ]);

    const venueCount = (status: string) => venueGroups.find((g) => g.status === status)?._count._all ?? 0;
    const bookingCount = (status: string) => bookingGroups.find((g) => g.status === status)?._count._all ?? 0;
    return {
      from: r.from,
      to: r.to,
      users: { total: users, newInPeriod: newUsers, blocked },
      venues: {
        total: venueGroups.reduce((sum, g) => sum + g._count._all, 0),
        pending: venueCount('PENDING'),
        approved: venueCount('APPROVED'),
        suspended: venueCount('SUSPENDED'),
        rejected: venueCount('REJECTED'),
      },
      bookings: {
        total: bookingGroups.reduce((sum, g) => sum + g._count._all, 0),
        confirmed: bookingCount('CONFIRMED'),
        completed: bookingCount('COMPLETED'),
        cancelled: bookingCount('CANCELLED'),
        expired: bookingCount('EXPIRED'),
        noShow: bookingCount('NO_SHOW'),
      },
      grossMinor: money._sum.basePriceMinor ?? 0,
      commissionMinor: money._sum.commissionMinor ?? 0,
      refundedMinor: refunded._sum.amountMinor ?? 0,
      pendingRefunds,
      failedRefunds,
      matches: { scheduled, completed },
      daily: fillDays(r, daily),
      topVenues: top.map((t) => ({ venueId: t.venueId, name: t.name, bookings: t.bookings, grossMinor: num(t.gross) })),
    };
  }

  // ───────────────────────── Complexe ─────────────────────────

  /** Tableau de bord d'un complexe : chiffres financiers, réservé aux gérants (rôle MANAGER au moins). */
  async venue(user: AuthUser, venueId: string, query: StatsQuery): Promise<VenueStats> {
    await this.policies.requireVenueRole(user, venueId, 'MANAGER');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } });
    if (!venue) throw Errors.notFound('Complexe introuvable');
    const r = rangeOf(query, venue.timezone);
    const where = { venueId, bookingType: { not: 'BLOCK' as const }, startsAt: { gte: r.start, lt: r.end } };

    const [groups, money, daily, hours, byHour, byField] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.booking.aggregate({
        where: { ...where, status: { in: [...COUNTED] } },
        _sum: { basePriceMinor: true, commissionMinor: true, venueAmountMinor: true, dueOnlineMinor: true, dueOnSiteMinor: true },
      }),
      this.prisma.$queryRaw<{ date: string; bookings: number; revenue: bigint }[]>`
        SELECT to_char(("startsAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS bookings, COALESCE(SUM("basePriceMinor"), 0)::bigint AS revenue
        FROM "Booking"
        WHERE "venueId" = ${venueId}::uuid AND "bookingType" <> 'BLOCK' AND "status" IN ('CONFIRMED', 'COMPLETED')
          AND "startsAt" >= ${r.start} AND "startsAt" < ${r.end}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ hours: number | null }[]>`
        SELECT (SUM(EXTRACT(EPOCH FROM ("endsAt" - "startsAt"))) / 3600.0)::float8 AS hours
        FROM "Booking"
        WHERE "venueId" = ${venueId}::uuid AND "bookingType" <> 'BLOCK' AND "status" IN ('CONFIRMED', 'COMPLETED')
          AND "startsAt" >= ${r.start} AND "startsAt" < ${r.end}`,
      this.prisma.$queryRaw<{ hour: number; bookings: number }[]>`
        SELECT EXTRACT(HOUR FROM ("startsAt" AT TIME ZONE ${r.tz}))::int AS hour, COUNT(*)::int AS bookings
        FROM "Booking"
        WHERE "venueId" = ${venueId}::uuid AND "bookingType" <> 'BLOCK' AND "status" IN ('CONFIRMED', 'COMPLETED')
          AND "startsAt" >= ${r.start} AND "startsAt" < ${r.end}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ fieldId: string; name: string; bookings: number; gross: bigint }[]>`
        SELECT f."id" AS "fieldId", f."name", COUNT(*)::int AS bookings, COALESCE(SUM(b."basePriceMinor"), 0)::bigint AS gross
        FROM "Booking" b JOIN "Field" f ON f."id" = b."fieldId"
        WHERE b."venueId" = ${venueId}::uuid AND b."bookingType" <> 'BLOCK' AND b."status" IN ('CONFIRMED', 'COMPLETED')
          AND b."startsAt" >= ${r.start} AND b."startsAt" < ${r.end}
        GROUP BY f."id", f."name" ORDER BY gross DESC`,
    ]);

    const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
    const played = count('COMPLETED') + count('NO_SHOW');
    return {
      from: r.from,
      to: r.to,
      bookings: { total: groups.reduce((sum, g) => sum + g._count._all, 0), confirmed: count('CONFIRMED'), completed: count('COMPLETED'), cancelled: count('CANCELLED'), noShow: count('NO_SHOW') },
      bookedHours: Math.round((hours[0]?.hours ?? 0) * 100) / 100,
      grossMinor: money._sum.basePriceMinor ?? 0,
      commissionMinor: money._sum.commissionMinor ?? 0,
      netMinor: money._sum.venueAmountMinor ?? 0,
      onlineMinor: money._sum.dueOnlineMinor ?? 0,
      onSiteMinor: money._sum.dueOnSiteMinor ?? 0,
      noShowRate: played === 0 ? 0 : Math.round((count('NO_SHOW') / played) * 1000) / 1000,
      daily: fillDays(r, daily),
      byHour: byHour.map((h) => ({ hour: h.hour, bookings: h.bookings })),
      byField: byField.map((f) => ({ fieldId: f.fieldId, name: f.name, bookings: f.bookings, grossMinor: num(f.gross) })),
    };
  }

  // ───────────────────────── Joueur ─────────────────────────

  async player(user: AuthUser, now: Date = new Date()): Promise<PlayerStats> {
    const [stats, upcomingBookings, upcomingMatches, teams, unread] = await Promise.all([
      this.prisma.playerStats.findUnique({ where: { userId: user.id } }),
      this.prisma.booking.count({ where: { userId: user.id, status: 'CONFIRMED', bookingType: 'STANDARD', startsAt: { gt: now } } }),
      this.prisma.match.count({ where: { status: 'SCHEDULED', startsAt: { gt: now }, participants: { some: { userId: user.id } } } }),
      this.prisma.team.count({ where: { deletedAt: null, members: { some: { userId: user.id, leftAt: null } } } }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return {
      matchesPlayed: stats?.matchesPlayed ?? 0,
      noShowCount: stats?.noShowCount ?? 0,
      lateCancelCount: stats?.lateCancelCount ?? 0,
      reliabilityScore: stats?.reliabilityScore ?? 100,
      upcomingBookings,
      upcomingMatches,
      teams,
      unreadNotifications: unread,
    };
  }
}
