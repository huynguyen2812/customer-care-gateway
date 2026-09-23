import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [installations, queued, sent, failed, optedOut, setting, recent] = await Promise.all([
      this.prisma.installation.count(),
      this.prisma.careJob.count({ where: { status: 'QUEUED' } }),
      this.prisma.careJob.count({ where: { status: 'SENT' } }),
      this.prisma.careJob.count({ where: { status: 'FAILED' } }),
      this.prisma.optOut.count(),
      this.prisma.systemSetting.findUnique({ where: { key: 'kill_switch' } }),
      this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, action: true, result: true, actorId: true, createdAt: true } }),
    ]);
    return { counts: { installations, queued, sent, failed, optedOut }, killSwitch: setting?.value || { enabled: false }, recent };
  }

  installations() {
    return this.prisma.installation.findMany({ orderBy: { createdAt: 'desc' }, select: {
      id: true, tenantId: true, sourceProduct: true, status: true, paused: true, dailyQuota: true,
      quietHoursStart: true, quietHoursEnd: true, timezone: true, lastConnectedAt: true, lastError: true, createdAt: true,
      zaloAccounts: { select: { id: true, channel: true, displayName: true, status: true, paused: true, isDefault: true, dailyQuota: true, lastConnectedAt: true, lastError: true } },
      petclinicConnection: { select: { apiBaseUrl: true, apiTenantId: true, allowedBranchIds: true, reminderLeadMinutes: true, active: true, lastSyncAt: true, lastSyncStatus: true, lastError: true } },
      _count: { select: { jobs: true, templates: true, optOuts: true } },
    }});
  }

  jobs(take = 100) {
    return this.prisma.careJob.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(take, 1), 250), select: {
      id: true, installationId: true, externalReferenceId: true, sourceProduct: true, eventType: true, templateCode: true,
      scheduledAt: true, consentStatus: true, status: true, attempts: true, failureCode: true, failureReason: true, sentAt: true, createdAt: true,
    }});
  }

  templates() {
    return this.prisma.messageTemplate.findMany({ orderBy: { updatedAt: 'desc' }, select: { id: true, installationId: true, code: true, body: true, allowedVariables: true, active: true, updatedAt: true } });
  }

  audits(take = 100) {
    return this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(take, 1), 250), select: {
      id: true, installationId: true, actorType: true, actorId: true, action: true, targetType: true, targetId: true, result: true, reason: true, metadata: true, createdAt: true,
    }});
  }

  async cancelJob(id: string, actorId: string) {
    const job = await this.prisma.careJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException();
    const result = await this.prisma.careJob.updateMany({ where: { id, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date(), failureCode: 'ADMIN_CANCELLED' } });
    await this.prisma.auditLog.create({ data: { installationId: job.installationId, actorType: 'ADMIN_UI', actorId, action: 'CARE_JOB_CANCELLED', targetType: 'CareJob', targetId: id, result: result.count ? 'SUCCESS' : 'NO_CHANGE' } });
    return { id, cancelled: result.count === 1 };
  }
}
