import { Injectable } from '@nestjs/common';
import { type CommissionRuleView, type SetCommissionInput, SETTING_SCHEMAS, type SettingKey } from '@footfive/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException, Errors } from '../../common/errors/app-exception.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { PrismaService } from '../../infra/database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { SettingsService } from '../settings/settings.service.js';

/** Verrou consultatif : deux modifications simultanées de la commission s'appliquent l'une après l'autre. */
const COMMISSION_LOCK = 727010;

type RuleRow = { id: string; scope: 'GLOBAL' | 'VENUE' | 'BOOKING_TYPE'; venueId: string | null; rateBps: number; fixedMinor: number; validFrom: Date; validTo: Date | null; isActive: boolean };
const toView = (r: RuleRow): CommissionRuleView => ({
  id: r.id,
  scope: r.scope,
  venueId: r.venueId,
  rateBps: r.rateBps,
  fixedMinor: r.fixedMinor,
  validFrom: r.validFrom.toISOString(),
  validTo: r.validTo?.toISOString() ?? null,
  isActive: r.isActive,
});

/**
 * Commission et paramètres de la plateforme. Une modification ne réécrit JAMAIS une règle existante : elle la clôture
 * et en crée une nouvelle, de sorte que l'historique est complet et que chaque réservation garde la règle (et les
 * montants figés) qui lui a été appliquée.
 */
@Injectable()
export class AdminCommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Règle effectivement appliquée à chaque complexe (complexe > globale), pour l'affichage. */
  async effectiveFor(venueIds: string[], now: Date = new Date()): Promise<Map<string, { rateBps: number; fixedMinor: number; scope: 'GLOBAL' | 'VENUE' | 'BOOKING_TYPE' }>> {
    const rules = await this.prisma.commissionRule.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
        AND: [{ OR: [{ scope: 'GLOBAL' }, { scope: 'VENUE', venueId: { in: venueIds } }] }],
      },
    });
    const global = rules.find((r) => r.scope === 'GLOBAL');
    const out = new Map<string, { rateBps: number; fixedMinor: number; scope: 'GLOBAL' | 'VENUE' | 'BOOKING_TYPE' }>();
    for (const id of venueIds) {
      const own = rules.find((r) => r.scope === 'VENUE' && r.venueId === id);
      const best = own ?? global;
      if (best) out.set(id, { rateBps: best.rateBps, fixedMinor: best.fixedMinor, scope: best.scope });
    }
    return out;
  }

  async overview(now: Date = new Date()): Promise<{ global: CommissionRuleView | null; venues: (CommissionRuleView & { venueName: string })[]; history: CommissionRuleView[] }> {
    const active = { isActive: true, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } satisfies Prisma.CommissionRuleWhereInput;
    const [global, venues, history] = await Promise.all([
      this.prisma.commissionRule.findFirst({ where: { scope: 'GLOBAL', ...active } }),
      this.prisma.commissionRule.findMany({ where: { scope: 'VENUE', ...active }, include: { venue: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.commissionRule.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return {
      global: global ? toView(global) : null,
      venues: venues.map((r) => ({ ...toView(r), venueName: r.venue?.name ?? '' })),
      history: history.map(toView),
    };
  }

  /** Nouveau taux global : s'applique aux réservations créées à partir de maintenant. */
  setGlobal(admin: AuthUser, input: SetCommissionInput, ctx: RequestContext): Promise<CommissionRuleView> {
    return this.replaceRule(admin, { scope: 'GLOBAL', venueId: null }, input, ctx);
  }

  async setVenue(admin: AuthUser, venueId: string, input: SetCommissionInput, ctx: RequestContext): Promise<CommissionRuleView> {
    if ((await this.prisma.venue.count({ where: { id: venueId } })) === 0) throw Errors.notFound('Complexe introuvable');
    return this.replaceRule(admin, { scope: 'VENUE', venueId }, input, ctx);
  }

  /** Retire le taux propre au complexe : il retombe sur le taux global. */
  async removeVenue(admin: AuthUser, venueId: string, ctx: RequestContext, now: Date = new Date()): Promise<void> {
    const closed = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMISSION_LOCK})`;
      const result = await tx.commissionRule.updateManyAndReturn({
        where: { scope: 'VENUE', venueId, isActive: true },
        data: { isActive: false, validTo: now },
        select: { id: true, rateBps: true, fixedMinor: true },
      });
      if (result.length > 0) {
        await this.audit.record({ actorId: admin.id, actorRole: 'ADMIN', action: 'commission.remove_venue', entityType: 'Venue', entityId: venueId, before: { rateBps: result[0]!.rateBps, fixedMinor: result[0]!.fixedMinor } }, ctx, tx);
      }
      return result.length;
    });
    if (closed === 0) throw Errors.notFound('Ce complexe n’a pas de taux particulier');
  }

  private async replaceRule(
    admin: AuthUser,
    target: { scope: 'GLOBAL' | 'VENUE'; venueId: string | null },
    input: SetCommissionInput,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CommissionRuleView> {
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMISSION_LOCK})`;
      const previous = await tx.commissionRule.updateManyAndReturn({
        where: { scope: target.scope, venueId: target.venueId, isActive: true },
        data: { isActive: false, validTo: now },
        select: { rateBps: true, fixedMinor: true },
      });
      const rule = await tx.commissionRule.create({
        data: { scope: target.scope, venueId: target.venueId, rateBps: input.rateBps, fixedMinor: input.fixedMinor, validFrom: now, createdById: admin.id },
      });
      await this.audit.record(
        {
          actorId: admin.id,
          actorRole: 'ADMIN',
          action: target.scope === 'GLOBAL' ? 'commission.update_global' : 'commission.update_venue',
          entityType: target.venueId ? 'Venue' : 'CommissionRule',
          entityId: target.venueId ?? rule.id,
          before: previous[0],
          after: { rateBps: input.rateBps, fixedMinor: input.fixedMinor, reason: input.reason ?? null },
        },
        ctx,
        tx,
      );
      return rule;
    });
    return toView(created);
  }

  // ───────────────────────── Paramètres ─────────────────────────

  async listSettings(): Promise<{ key: string; value: unknown; updatedAt: string | null }[]> {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: Object.keys(SETTING_SCHEMAS) } }, orderBy: { key: 'asc' } });
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt.toISOString() }));
  }

  /** Seules les clés connues sont modifiables, chacune avec SA validation (bornes comprises). */
  async updateSetting(admin: AuthUser, key: string, value: unknown, ctx: RequestContext): Promise<{ key: string; value: unknown }> {
    if (!Object.hasOwn(SETTING_SCHEMAS, key)) throw Errors.notFound('Paramètre inconnu');
    const parsed = SETTING_SCHEMAS[key as SettingKey].safeParse(value);
    if (!parsed.success) {
      throw new AppException('VALIDATION_ERROR', 400, 'Valeur invalide pour ce paramètre', parsed.error.issues.map((i) => ({ path: ['value', ...i.path].join('.'), message: i.message, code: i.code })));
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key } });
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value: parsed.data as Prisma.InputJsonValue, updatedById: admin.id },
        update: { value: parsed.data as Prisma.InputJsonValue, updatedById: admin.id },
      });
      await this.audit.record(
        { actorId: admin.id, actorRole: 'ADMIN', action: 'setting.update', entityType: 'PlatformSetting', entityId: null, before: { key, value: (before?.value ?? null) as Prisma.InputJsonValue }, after: { key, value: parsed.data as Prisma.InputJsonValue } },
        ctx,
        tx,
      );
    });
    this.settings.invalidate();
    return { key, value: parsed.data };
  }
}
