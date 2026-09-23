import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}
  async run(now = new Date()): Promise<{ purgedJobs: number; deletedNonces: number }> {
    const piiCutoff = new Date(now.getTime() - 30 * 24 * 3600_000);
    const nonceCutoff = new Date(now.getTime() - 10 * 60_000);
    const [purged, requestNonces, controlNonces] = await this.prisma.$transaction([
      this.prisma.careJob.updateMany({ where: { status: { in: ['SENT', 'FAILED', 'CANCELLED', 'OPTED_OUT', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND'] }, updatedAt: { lt: piiCutoff }, NOT: { recipientNameEnc: 'PURGED' } }, data: { recipientNameEnc: 'PURGED', phoneEnc: 'PURGED', templateVariables: {} } }),
      this.prisma.requestNonce.deleteMany({ where: { seenAt: { lt: nonceCutoff } } }),
      this.prisma.controlNonce.deleteMany({ where: { seenAt: { lt: nonceCutoff } } }),
    ]);
    return { purgedJobs: purged.count, deletedNonces: requestNonces.count + controlNonces.count };
  }
}
