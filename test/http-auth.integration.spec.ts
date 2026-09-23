import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import request = require('supertest');
import { AppModule } from '../src/app.module';

describe('HTTP installation authentication', () => {
  const prisma = new PrismaClient(); let app: INestApplication; let installationId = '';
  const secret = randomBytes(32).toString('base64url'); const clientId = `test_${randomUUID()}`;
  const signingKey = createHash('sha256').update(secret).digest('hex');

  beforeAll(async () => {
    process.env.PHONE_HASH_PEPPER = randomBytes(32).toString('hex'); process.env.DATA_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64'); process.env.WORKER_ENABLED = 'false';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.setGlobalPrefix('api/v1'); await app.init();
    const installation = await prisma.installation.create({ data: { tenantId: randomUUID(), sourceProduct: 'PETCLINIC_ESSENTIAL', status: 'ACTIVE', scopes: ['care:job:create', 'care:job:read', 'care:job:cancel'] } }); installationId = installation.id;
    await prisma.apiCredential.create({ data: { installationId, clientId, secretHash: signingKey, secretLast4: secret.slice(-4) } });
  });

  afterAll(async () => {
    await prisma.requestNonce.deleteMany({ where: { installationId } }); await prisma.careJob.deleteMany({ where: { installationId } }); await prisma.installation.delete({ where: { id: installationId } });
    await app.close(); await prisma.$disconnect();
  });

  function signed(raw: string, nonce = randomUUID(), key = signingKey) {
    const timestamp = Date.now().toString(); const path = '/api/v1/care-jobs'; const bodyHash = createHash('sha256').update(raw).digest('hex');
    const signature = createHmac('sha256', key).update(`POST\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    return { nonce, headers: { 'x-care-client-id': clientId, 'x-care-timestamp': timestamp, 'x-care-nonce': nonce, 'x-care-signature': signature } };
  }

  function payload() { return JSON.stringify({ sourceProduct: 'PETCLINIC_ESSENTIAL', externalReferenceId: `appointment:${randomUUID()}`, eventType: 'APPOINTMENT_REMINDER', recipient: { name: 'Khach Test', phone: '0901234567' }, templateCode: 'PC_APPT_REMINDER_V1', templateVariables: {}, scheduledAt: new Date(Date.now() + 60000).toISOString(), consentStatus: 'GRANTED', idempotencyKey: randomUUID() }); }

  it('accepts a valid signature and rejects replay', async () => {
    const raw = payload(); const auth = signed(raw);
    await request(app.getHttpServer()).post('/api/v1/care-jobs').set(auth.headers).set('content-type', 'application/json').send(raw).expect(201);
    await request(app.getHttpServer()).post('/api/v1/care-jobs').set(auth.headers).set('content-type', 'application/json').send(raw).expect(401);
  });

  it('rejects a wrong signature without revealing credential existence', async () => {
    const raw = payload(); const auth = signed(raw, randomUUID(), 'wrong-derived-key');
    const response = await request(app.getHttpServer()).post('/api/v1/care-jobs').set(auth.headers).set('content-type', 'application/json').send(raw).expect(401);
    expect(response.body.message).toBe('Invalid request authentication');
  });
});
