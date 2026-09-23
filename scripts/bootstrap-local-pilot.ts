import { PrismaClient, SourceProduct } from '@prisma/client';
import { InstallationsService } from '../src/installations/installations.service';
import { CryptoService } from '../src/common/crypto.service';

async function main() {
  const senderSigningKey = String(process.env.LOCAL_SENDER_SIGNING_KEY || '');
  if (senderSigningKey.length < 32) throw new Error('LOCAL_SENDER_SIGNING_KEY must be at least 32 characters');
  const prisma = new PrismaClient(); const crypto = new CryptoService();
  const service = new InstallationsService(prisma as any, crypto);
  const tenantId = '9a684c74-9e4d-4d80-b98d-9a320c726bcb';
  let installation = await prisma.installation.findUnique({ where: { tenantId_sourceProduct: { tenantId, sourceProduct: SourceProduct.PETCLINIC_ESSENTIAL } } });
  if (!installation) {
    const created = await service.create({ tenantId, sourceProduct: 'PETCLINIC_ESSENTIAL', scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'], dailyQuota: 20 }, 'local-pilot-bootstrap');
    installation = await prisma.installation.findUniqueOrThrow({ where: { id: created.installationId } });
  }
  await service.upsertTemplate(installation.id, { code: 'PC_APPT_REMINDER_V1', body: 'Vetclinic xin nhac lich hen cua {{petName}} vao {{appointmentTime}}. Neu can doi lich, vui long phan hoi tin nhan nay.', allowedVariables: ['petName', 'appointmentTime'], active: true }, 'local-pilot-bootstrap');
  await service.configurePersonalZalo(installation.id, { senderBaseUrl: 'http://127.0.0.1:3000', senderClientId: 'customer-care-gateway-local', signingKey: senderSigningKey }, 'local-pilot-bootstrap');
  console.log(JSON.stringify({ installationId: installation.id, tenantId, channel: 'PERSONAL_ZALO', dailyQuota: 20, noMessageSent: true }));
  await prisma.$disconnect();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
