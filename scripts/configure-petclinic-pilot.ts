import { PrismaClient, SourceProduct } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { InstallationsService } from '../src/installations/installations.service';
import { CareJobsService } from '../src/care-jobs/care-jobs.service';
import { PetclinicClientService } from '../src/petclinic/petclinic-client.service';
import { PetclinicSyncService } from '../src/petclinic/petclinic-sync.service';

function required(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const prisma = new PrismaClient(); const crypto = new CryptoService();
  const installations = new InstallationsService(prisma as any, crypto);
  const sync = new PetclinicSyncService(prisma as any, crypto, new PetclinicClientService(crypto), new CareJobsService(prisma as any, crypto));
  const tenantId = required('PETCLINIC_GATEWAY_TENANT_UUID');
  const branches = required('PETCLINIC_ALLOWED_BRANCH_IDS').split(',').map((value) => value.trim()).filter(Boolean);
  const pilotPhones = required('PETCLINIC_PILOT_ALLOWED_PHONES').split(',').map((value) => value.trim()).filter(Boolean);
  let installation = await prisma.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId, sourceProduct: SourceProduct.PETCLINIC_OPERATING } } });
  if (!installation) {
    const result = await installations.create({ tenantId, sourceProduct: SourceProduct.PETCLINIC_OPERATING, scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], dailyQuota: 20 }, 'local-petclinic-pilot');
    installation = await prisma.installation.findUniqueOrThrow({ where: { id: result.installationId } });
  }
  await installations.upsertTemplate(installation.id, {
    code: 'PC_APPT_REMINDER_V1',
    body: 'Vetclinic xin chào {{ownerName}}. Xin nhắc lịch của {{petName}} vào {{appointmentTime}} cho dịch vụ {{serviceName}}. Nếu cần đổi lịch, vui lòng phản hồi tin nhắn này.',
    allowedVariables: ['ownerName', 'petName', 'appointmentTime', 'serviceName'], active: true,
  }, 'local-petclinic-pilot');
  await sync.configure(installation.id, {
    apiBaseUrl: required('PETCLINIC_API_BASE'), apiToken: required('PETCLINIC_API_TOKEN'), apiTenantId: required('PETCLINIC_API_TENANT_ID'),
    allowedBranchIds: branches, pilotAllowedPhones: pilotPhones, reminderLeadMinutes: Number(process.env.PETCLINIC_REMINDER_LEAD_MINUTES || 1440), active: true,
  }, 'local-petclinic-pilot');
  const preview = await sync.sync(installation.id, {}, 'local-petclinic-pilot');
  console.log(JSON.stringify({ installationId: installation.id, dryRun: true, preview, noMessageSent: true }));
  await prisma.$disconnect();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
