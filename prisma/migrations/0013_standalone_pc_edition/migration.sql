-- Standalone PC Edition (forward-only, additive). Tables stay empty in the VPS/Platform deployment.

ALTER TYPE "SourceProduct" ADD VALUE 'EXTERNAL_CONNECTOR';

-- Self-issued credentials keep the HMAC signing key encrypted; secretHash becomes a fingerprint only.
ALTER TABLE "ApiCredential" ADD COLUMN "signingKeyEnc" TEXT;

-- One business per PC: a single row whose id is pinned to 1.
CREATE TABLE "StandaloneInstance" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tenantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StandaloneInstance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StandaloneInstance_singleton" CHECK ("id" = 1)
);
CREATE UNIQUE INDEX "StandaloneInstance_tenantId_key" ON "StandaloneInstance"("tenantId");

CREATE TABLE "LocalUser" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "username" VARCHAR(80) NOT NULL,
    "displayName" VARCHAR(200),
    "passwordHash" VARCHAR(300) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "createdBy" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalUser_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LocalUser_role_check" CHECK ("role" IN ('CRM_OWNER', 'CRM_ADMIN', 'CRM_STAFF', 'CRM_VIEWER')),
    CONSTRAINT "LocalUser_username_lower" CHECK ("username" = lower("username"))
);
CREATE UNIQUE INDEX "LocalUser_username_key" ON "LocalUser"("username");
CREATE INDEX "LocalUser_tenantId_idx" ON "LocalUser"("tenantId");
ALTER TABLE "LocalUser" ADD CONSTRAINT "LocalUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "CrmTenant"("platformTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SourceConnection" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "apiBaseUrl" VARCHAR(300) NOT NULL,
    "appointmentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "receivablesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedBranchIds" TEXT[],
    "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 1440,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" VARCHAR(40),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceConnection_installationId_key" ON "SourceConnection"("installationId");
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
