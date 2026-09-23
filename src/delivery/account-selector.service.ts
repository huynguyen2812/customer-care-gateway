import { Injectable } from '@nestjs/common';
import { CareJob, Installation, ZaloAccount, ZaloRoutingRule } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { dayKey } from '../common/day-key';
import { capabilitiesOf } from '../channel/channel.adapter';
import { mockAllowed } from '../channel/channel-router.service';
import { PersonalZaloAdapter } from '../channel/personal-zalo.adapter';

export type Candidate = { account: ZaloAccount; tier: 1 | 2 | 3; rule: ZaloRoutingRule | null; eventSpecific: boolean; load: number };
export type Selection =
  | { kind: 'SELECTED'; account: ZaloAccount; tier: number; ruleId: string | null; reason: string; preflight?: string }
  | { kind: 'NONE'; reason: 'NO_ELIGIBLE_ACCOUNT' | 'RECIPIENT_NOT_FOUND' };

export const TIER_LABEL = { 1: 'BRANCH', 2: 'INSTALLATION', 3: 'TENANT_DEFAULT' } as const;

/** Why an account cannot be used right now (null = usable). Pure: used by worker and CRM API. */
export function unavailableReason(a: ZaloAccount): string | null {
  if (a.revokedAt || a.status === 'REVOKED') return 'REVOKED';
  if (a.paused) return 'PAUSED';
  if (a.status !== 'CONNECTED') return a.status;
  if (a.channel === 'MOCK') return mockAllowed() ? null : 'CHANNEL_NOT_ALLOWED';
  if (a.channel === 'ZNS') return 'CHANNEL_NOT_SUPPORTED';
  if (!a.senderBaseUrl || !a.senderClientId || !a.credentialEnc) return 'CREDENTIAL_MISSING';
  return null;
}

/**
 * Chooses the account for a job:
 *   1. only accounts of the job's tenant, usable (CONNECTED, not paused/revoked, credential present,
 *      allowed channel) and with account quota left today;
 *   2. most specific assignment wins: branch rule (tier 1) > installation rule (tier 2) > tenant
 *      default (tier 3); event-specific rules beat generic ones inside a tier;
 *   3. then rule priority, account priority, today's load ratio, id — fully deterministic.
 * Accounts that match no rule and are not the tenant default are never used.
 * Recipient preflight is used only when every candidate supports it (sender contract v2); it never
 * sends, befriends or creates a conversation. Without it no account is "probed" by sending.
 */
@Injectable()
export class AccountSelectorService {
  constructor(private readonly prisma: PrismaService, private readonly personal: PersonalZaloAdapter) {}

  async candidates(job: Pick<CareJob, 'installationId' | 'branchId' | 'eventType'>, installation: Installation, exclude: string[] = []): Promise<Candidate[]> {
    const [accounts, rules] = await Promise.all([
      this.prisma.zaloAccount.findMany({ where: { tenantId: installation.tenantId, revokedAt: null } }),
      this.prisma.zaloRoutingRule.findMany({ where: { tenantId: installation.tenantId, active: true } }),
    ]);
    const out: Candidate[] = [];
    for (const account of accounts) {
      if (exclude.includes(account.id) || unavailableReason(account)) continue;
      const own = rules.filter((r) => r.zaloAccountId === account.id && (!r.eventType || r.eventType === job.eventType));
      let best: Omit<Candidate, 'account' | 'load'> | null = null;
      for (const r of own) {
        const tier = r.branchId ? (job.branchId && r.branchId === job.branchId && (!r.installationId || r.installationId === job.installationId) ? 1 : null)
          : r.installationId ? (r.installationId === job.installationId ? 2 : null) : 3;
        if (!tier) continue;
        const c = { tier: tier as 1 | 2 | 3, rule: r, eventSpecific: !!r.eventType };
        if (!best || c.tier < best.tier || (c.tier === best.tier && (Number(c.eventSpecific) > Number(best.eventSpecific) || (c.eventSpecific === best.eventSpecific && r.priority < (best.rule?.priority ?? Infinity))))) best = c;
      }
      if (!best && account.isDefault) best = { tier: 3, rule: null, eventSpecific: false };
      if (!best) continue;
      const used = (await this.prisma.deliveryQuotaCounter.findUnique({ where: { scope_scopeId_day: { scope: 'ACCOUNT', scopeId: account.id, day: dayKey(new Date(), account.timezone) } } }))?.used ?? 0;
      if (used >= account.dailyQuota) continue;
      out.push({ account, ...best, load: account.dailyQuota ? used / account.dailyQuota : 1 });
    }
    return out.sort((a, b) => a.tier - b.tier || Number(b.eventSpecific) - Number(a.eventSpecific) || (a.rule?.priority ?? 1000) - (b.rule?.priority ?? 1000) || a.account.priority - b.account.priority || a.load - b.load || a.account.id.localeCompare(b.account.id));
  }

  async select(job: CareJob, installation: Installation, phoneE164: string, exclude: string[] = []): Promise<Selection> {
    // Sticky: keep the previously chosen account while it remains usable for this job.
    const list = await this.candidates(job, installation, exclude);
    if (job.selectedZaloAccountId) {
      const sticky = list.find((c) => c.account.id === job.selectedZaloAccountId);
      if (sticky) return { kind: 'SELECTED', account: sticky.account, tier: sticky.tier, ruleId: sticky.rule?.id ?? null, reason: 'STICKY' };
    }
    if (!list.length) return { kind: 'NONE', reason: 'NO_ELIGIBLE_ACCOUNT' };
    const preflightAll = list.every((c) => c.account.channel === 'PERSONAL_ZALO' && capabilitiesOf(c.account).recipientPreflight);
    if (!preflightAll) return { kind: 'SELECTED', account: list[0].account, tier: list[0].tier, ruleId: list[0].rule?.id ?? null, reason: 'RULE' };
    let allNotFound = true;
    for (const c of list) {
      const r = await this.personal.recipientEligibility(c.account, phoneE164);
      if (r === 'ELIGIBLE_EXISTING_FRIEND' || r === 'ELIGIBLE_EXISTING_CONVERSATION') return { kind: 'SELECTED', account: c.account, tier: c.tier, ruleId: c.rule?.id ?? null, reason: 'RULE_WITH_PREFLIGHT', preflight: r };
      if (r !== 'NOT_FOUND') allNotFound = false;
    }
    return { kind: 'NONE', reason: allNotFound ? 'RECIPIENT_NOT_FOUND' : 'NO_ELIGIBLE_ACCOUNT' };
  }
}
