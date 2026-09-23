-- CreateEnum
CREATE TYPE "SourceProduct" AS ENUM ('B2B_SALE', 'PETCLINIC_ESSENTIAL');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'ROTATING_OUT', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CareJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'OPTED_OUT', 'ACCOUNT_RESTRICTED', 'RECIPIENT_NOT_FOUND');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('MOCK', 'PERSONAL_ZALO', 'ZNS');

-- CreateTable
CREATE TABLE "Installation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceProduct" "SourceProduct" NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'PENDING',
    "scopes" TEXT[],
    "callbackUrl" TEXT,
    "callbackSecretEnc" TEXT,
    "dailyQuota" INTEGER NOT NULL DEFAULT 30,
    "quietHoursStart" VARCHAR(5) NOT NULL DEFAULT '21:00',
    "quietHoursEnd" VARCHAR(5) NOT NULL DEFAULT '08:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "expiresAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" VARCHAR(500),
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "secretHash" VARCHAR(64) NOT NULL,
    "secretLast4" VARCHAR(8) NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestNonce" (
    "installationId" UUID NOT NULL,
    "nonce" VARCHAR(80) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestNonce_pkey" PRIMARY KEY ("installationId","nonce")
);

-- CreateTable
CREATE TABLE "CareJob" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "externalReferenceId" VARCHAR(160) NOT NULL,
    "sourceProduct" "SourceProduct" NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "recipientNameEnc" TEXT NOT NULL,
    "phoneEnc" TEXT NOT NULL,
    "phoneHash" VARCHAR(64) NOT NULL,
    "templateCode" VARCHAR(100) NOT NULL,
    "templateVariables" JSONB NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "consentStatus" "ConsentStatus" NOT NULL,
    "status" "CareJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" VARCHAR(100),
    "providerMessageId" VARCHAR(160),
    "failureCode" VARCHAR(80),
    "failureReason" VARCHAR(500),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptOut" (
    "installationId" UUID NOT NULL,
    "phoneHash" VARCHAR(64) NOT NULL,
    "source" VARCHAR(80) NOT NULL,
    "reason" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptOut_pkey" PRIMARY KEY ("installationId","phoneHash")
);

-- CreateTable
CREATE TABLE "ZaloAccount" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "displayName" VARCHAR(160),
    "status" VARCHAR(40) NOT NULL,
    "credentialEnc" TEXT,
    "dailySentCount" INTEGER NOT NULL DEFAULT 0,
    "dailyCountDate" VARCHAR(10),
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" VARCHAR(500),

    CONSTRAINT "ZaloAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "careJobId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "CareJobStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastHttpStatus" INTEGER,
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "installationId" UUID,
    "tenantId" UUID,
    "actorType" VARCHAR(40) NOT NULL,
    "actorId" VARCHAR(160),
    "action" VARCHAR(120) NOT NULL,
    "targetType" VARCHAR(80),
    "targetId" VARCHAR(160),
    "result" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(500),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" VARCHAR(160) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Installation_status_expiresAt_idx" ON "Installation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Installation_tenantId_sourceProduct_key" ON "Installation"("tenantId", "sourceProduct");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_clientId_key" ON "ApiCredential"("clientId");

-- CreateIndex
CREATE INDEX "ApiCredential_installationId_status_idx" ON "ApiCredential"("installationId", "status");

-- CreateIndex
CREATE INDEX "RequestNonce_seenAt_idx" ON "RequestNonce"("seenAt");

-- CreateIndex
CREATE INDEX "CareJob_status_scheduledAt_nextAttemptAt_idx" ON "CareJob"("status", "scheduledAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CareJob_installationId_externalReferenceId_idx" ON "CareJob"("installationId", "externalReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CareJob_installationId_idempotencyKey_key" ON "CareJob"("installationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ZaloAccount_installationId_key" ON "ZaloAccount"("installationId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_nextAttemptAt_deliveredAt_idx" ON "WebhookDelivery"("nextAttemptAt", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_careJobId_sequence_key" ON "WebhookDelivery"("careJobId", "sequence");

-- CreateIndex
CREATE INDEX "AuditLog_installationId_createdAt_idx" ON "AuditLog"("installationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestNonce" ADD CONSTRAINT "RequestNonce_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareJob" ADD CONSTRAINT "CareJob_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptOut" ADD CONSTRAINT "OptOut_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZaloAccount" ADD CONSTRAINT "ZaloAccount_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_careJobId_fkey" FOREIGN KEY ("careJobId") REFERENCES "CareJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
