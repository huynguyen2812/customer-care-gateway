import { Controller, ForbiddenException, Get, Header, Req } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../common/prisma.service';
import { LicenseGateService } from './platform/license-gate.service';
import { buildInfo } from './platform/platform-device.service';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function localOnly(req: Request) {
  if (!LOOPBACK.has(String(req.socket.remoteAddress || ''))) throw new ForbiddenException({ code: 'LOCAL_ONLY' });
}

/**
 * Standalone PC edition only. Unauthenticated but loopback-only and PII-free: counts and states for the tray icon and
 * the diagnostics bundle (no names, phones, message content, ids or secrets).
 */
@Controller()
export class LocalStatusController {
  constructor(private readonly prisma: PrismaService, private readonly licence: LicenseGateService) {}

  @Get('local-status')
  async status(@Req() req: Request) {
    localOnly(req);
    const since = new Date(Date.now() - 24 * 3600_000);
    const [inst, queued, processing, sent24h, failed24h, uncertain, zalo, conn, kill] = await Promise.all([
      this.prisma.standaloneInstance.findUnique({ where: { id: 1 } }),
      this.prisma.careJob.count({ where: { status: 'QUEUED' } }),
      this.prisma.careJob.count({ where: { status: 'PROCESSING' } }),
      this.prisma.careJob.count({ where: { status: 'SENT', sentAt: { gte: since } } }),
      this.prisma.careJob.count({ where: { status: { in: ['FAILED', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'] }, updatedAt: { gte: since } } }),
      this.prisma.careJob.count({ where: { failureCode: 'DELIVERY_UNCERTAIN' } }),
      this.prisma.zaloAccount.groupBy({ by: ['status'], where: { revokedAt: null }, _count: { _all: true } }),
      this.prisma.sourceConnection.findFirst({ select: { active: true, lastSyncAt: true, lastSyncStatus: true } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } }),
    ]);
    const zaloStates = Object.fromEntries(zalo.map((z) => [z.status, z._count._all]));
    const lic = await this.licence.evaluate();
    const b = buildInfo();
    return {
      mode: 'standalone', setupRequired: !inst, version: b.version, buildCommit: b.crmCommit,
      // Licence summary: codes/timestamps only (no business name, no device id).
      platform: { managed: lic.mode === 'MANAGED', activationRequired: lic.deny === 'PLATFORM_ACTIVATION_REQUIRED', licenseBypass: lic.mode === 'BYPASS', status: lic.registration?.status ?? 'NOT_PAIRED', allowed: lic.deny === null, reason: lic.deny, licensedUntil: lic.window?.until ?? null, configExpiresAt: lic.window?.configExpiresAt ?? null, lastValidatedAt: lic.registration?.lastValidatedAt ?? null },
      emergencyStop: (kill?.value as { enabled?: boolean } | null)?.enabled === true,
      queue: { queued, processing, sent24h, failed24h, deliveryUncertain: uncertain },
      zalo: { total: zalo.reduce((n, z) => n + z._count._all, 0), connected: zaloStates.CONNECTED || 0, needLogin: (zaloStates.PENDING_LOGIN || 0) + (zaloStates.RELOGIN_REQUIRED || 0) + (zaloStates.DISCONNECTED || 0) },
      source: conn ? { configured: true, active: conn.active, lastSyncAt: conn.lastSyncAt, lastSyncStatus: conn.lastSyncStatus } : { configured: false },
      at: new Date().toISOString(),
    };
  }

  /** AGPL notices of the bundled Zalo Sender (attribution + source link), shown on the CRM "Giấy phép" page. */
  @Get('legal/sender')
  @Header('content-type', 'text/plain; charset=utf-8')
  async senderLegal() {
    const base = process.env.SENDER_V2_BASE_URL || 'http://127.0.0.1:47110';
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/legal`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (res.ok) return await res.text();
    } catch { /* fall through */ }
    return 'VETCLINIC Zalo Sender — bản sửa đổi của ZaloCRM (GNU AGPL-3.0). Dịch vụ Sender chưa phản hồi; xem các file LICENSE, NOTICE và sender-source.zip trong thư mục cài đặt (C:\\Program Files\\VETCLINIC CRM\\app\\<phiên bản>\\sender).';
  }
}
