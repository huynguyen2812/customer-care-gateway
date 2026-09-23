-- 0006 VETCLINIC CRM tenant access: Platform-issued tenant/entitlement cache, server-side CRM
-- sessions (revocable), SSO token replay guard and idempotent Platform event log.
-- Additive only: no existing table/column is altered or dropped.

-- CreateTable
CREATE TABLE "CrmTenant" (
    "platformTenantId" UUID NOT NULL,
    "displayName" VARCHAR(200),
    "platformInstallationId" UUID,
    "platformClientId" VARCHAR(100),
    "platformClientSecretEnc" TEXT,
    "callbackBaseUrl" VARCHAR(300),
    "installationStatus" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "entitlementStatus" VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    "planCode" VARCHAR(64),
    "limits" JSONB,
    "features" JSONB,
    "entitlementStartsAt" TIMESTAMP(3),
    "entitlementExpiresAt" TIMESTAMP(3),
    "entitlementUpdatedAt" TIMESTAMP(3),
    "autoSendPaused" BOOLEAN NOT NULL DEFAULT false,
    "autoSendPausedAt" TIMESTAMP(3),
    "autoSendPausedBy" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmTenant_pkey" PRIMARY KEY ("platformTenantId")
);

-- CreateTable
CREATE TABLE "CrmSession" (
    "id" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "platformTenantId" UUID NOT NULL,
    "platformUserId" UUID NOT NULL,
    "productCode" VARCHAR(40) NOT NULL,
    "roles" TEXT[],
    "displayName" VARCHAR(200),
    "username" VARCHAR(160),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkGraceUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" VARCHAR(80),
    "userAgent" VARCHAR(300),

    CONSTRAINT "CrmSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSsoTokenReplay" (
    "jti" VARCHAR(100) NOT NULL,
    "platformTenantId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmSsoTokenReplay_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "PlatformEvent" (
    "eventId" VARCHAR(80) NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "platformTenantId" UUID,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" VARCHAR(40) NOT NULL,

    CONSTRAINT "PlatformEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmTenant_platformClientId_key" ON "CrmTenant"("platformClientId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmSession_tokenHash_key" ON "CrmSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CrmSession_platformTenantId_platformUserId_idx" ON "CrmSession"("platformTenantId", "platformUserId");

-- CreateIndex
CREATE INDEX "CrmSession_expiresAt_idx" ON "CrmSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CrmSsoTokenReplay_expiresAt_idx" ON "CrmSsoTokenReplay"("expiresAt");

-- CreateIndex
CREATE INDEX "PlatformEvent_platformTenantId_receivedAt_idx" ON "PlatformEvent"("platformTenantId", "receivedAt");

-- AddForeignKey
ALTER TABLE "CrmSession" ADD CONSTRAINT "CrmSession_platformTenantId_fkey" FOREIGN KEY ("platformTenantId") REFERENCES "CrmTenant"("platformTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

