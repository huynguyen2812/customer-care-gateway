import { Injectable } from '@nestjs/common';
import { Installation, Prisma, ZaloAccount } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { dayKey } from '../common/day-key';

export type QuotaScope = { scope: 'TENANT' | 'INSTALLATION' | 'ACCOUNT'; scopeId: string; day: string; limit: number };
export type Reservation = { scopes: QuotaScope[] };
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; exhausted: QuotaScope['scope'] };

type Tx = Prisma.TransactionClient;

/**
 * Daily quota as atomic reservations. For each scope, a single `INSERT … ON CONFLICT DO UPDATE …
 * WHERE used < limit RETURNING` either takes one unit or returns no row. All scopes are taken inside
 * one transaction, so two workers can never both consume "the last" unit, and a partial reservation
 * is rolled back. A reservation is released only when the send is certainly NOT_SENT; UNKNOWN keeps it.
 */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tenant limit = min(tenant cap, plan dailyQuotaMax). Null when neither is set (legacy pilot). */
  async tenantLimit(tenantId: string, tx: Tx | PrismaService = this.prisma): Promise<{ limit: number | null; timezone: string }> {
    const t = await tx.crmTenant.findUnique({ where: { platformTenantId: tenantId }, select: { tenantDailyQuota: true, limits: true, timezone: true } });
    if (!t) return { limit: null, timezone: 'Asia/Ho_Chi_Minh' };
    const plan = (t.limits as Record<string, unknown> | null)?.dailyQuotaMax;
    const values = [t.tenantDailyQuota, typeof plan === 'number' && plan > 0 ? plan : null].filter((v): v is number => typeof v === 'number');
    return { limit: values.length ? Math.min(...values) : null, timezone: t.timezone };
  }

  async scopesFor(installation: Installation, account: ZaloAccount, now = new Date()): Promise<QuotaScope[]> {
    const tenant = await this.tenantLimit(installation.tenantId);
    const scopes: QuotaScope[] = [];
    if (tenant.limit !== null) scopes.push({ scope: 'TENANT', scopeId: installation.tenantId, day: dayKey(now, tenant.timezone), limit: tenant.limit });
    scopes.push({ scope: 'INSTALLATION', scopeId: installation.id, day: dayKey(now, installation.timezone), limit: installation.dailyQuota });
    scopes.push({ scope: 'ACCOUNT', scopeId: account.id, day: dayKey(now, account.timezone), limit: account.dailyQuota });
    return scopes;
  }

  private async takeOne(tx: Tx, s: QuotaScope): Promise<boolean> {
    if (s.limit < 1) return false;
    const rows = await tx.$queryRaw<{ used: number }[]>`
      INSERT INTO "DeliveryQuotaCounter" ("scope", "scopeId", "day", "used", "updatedAt")
      VALUES (${s.scope}, ${s.scopeId}::uuid, ${s.day}, 1, NOW())
      ON CONFLICT ("scope", "scopeId", "day") DO UPDATE
        SET "used" = "DeliveryQuotaCounter"."used" + 1, "updatedAt" = NOW()
        WHERE "DeliveryQuotaCounter"."used" < ${s.limit}
      RETURNING "used"`;
    return rows.length === 1;
  }

  /** Reserve inside an existing transaction (the caller also creates the attempt in it). */
  async reserveIn(tx: Tx, scopes: QuotaScope[]): Promise<ReserveResult> {
    for (const s of scopes) {
      if (!(await this.takeOne(tx, s))) return { ok: false, exhausted: s.scope };
    }
    return { ok: true, reservation: { scopes } };
  }

  async release(scopes: QuotaScope[], tx: Tx | PrismaService = this.prisma): Promise<void> {
    for (const s of scopes) {
      await tx.$executeRaw`UPDATE "DeliveryQuotaCounter" SET "used" = GREATEST("used" - 1, 0), "updatedAt" = NOW() WHERE "scope" = ${s.scope} AND "scopeId" = ${s.scopeId}::uuid AND "day" = ${s.day}`;
    }
  }

  async used(scope: QuotaScope['scope'], scopeId: string, day: string): Promise<number> {
    const row = await this.prisma.deliveryQuotaCounter.findUnique({ where: { scope_scopeId_day: { scope, scopeId, day } } });
    return row?.used ?? 0;
  }
}
