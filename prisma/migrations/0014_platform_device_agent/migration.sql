-- Platform Device Agent for the standalone PC edition (forward-only, additive). Empty in the VPS/Platform deployment.
-- Never stores the activation code, source API credentials, Zalo sessions or customer data.

CREATE TABLE "PlatformDeviceRegistration" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "deviceId" UUID NOT NULL,
    "devicePublicKey" TEXT NOT NULL,
    "devicePrivateKeyEnc" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "pendingRequestId" UUID,
    "platformInstallationId" VARCHAR(100),
    "platformTenantId" VARCHAR(100),
    "businessName" VARCHAR(200),
    "pairedAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastConfigRevision" INTEGER NOT NULL DEFAULT 0,
    "entitlementValidUntil" TIMESTAMP(3),
    "offlineGraceUntil" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" VARCHAR(80),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformDeviceRegistration_pkey" PRIMARY KEY ("id"),
    -- One primary PC per business for now; deviceId stays unique so more devices can be added later.
    CONSTRAINT "PlatformDeviceRegistration_singleton" CHECK ("id" = 1),
    CONSTRAINT "PlatformDeviceRegistration_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'REVOKED', 'UNPAIRED'))
);
CREATE UNIQUE INDEX "PlatformDeviceRegistration_deviceId_key" ON "PlatformDeviceRegistration"("deviceId");

CREATE TABLE "PlatformDesiredConfiguration" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "signature" VARCHAR(200) NOT NULL,
    "keyId" VARCHAR(80) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "applyStatus" VARCHAR(20) NOT NULL,
    "applyError" VARCHAR(80),
    CONSTRAINT "PlatformDesiredConfiguration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformDesiredConfiguration_revision_positive" CHECK ("revision" > 0),
    CONSTRAINT "PlatformDesiredConfiguration_apply_status_check" CHECK ("applyStatus" IN ('APPLIED', 'FAILED'))
);
CREATE UNIQUE INDEX "PlatformDesiredConfiguration_deviceId_revision_key" ON "PlatformDesiredConfiguration"("deviceId", "revision");
CREATE INDEX "PlatformDesiredConfiguration_deviceId_appliedAt_idx" ON "PlatformDesiredConfiguration"("deviceId", "appliedAt");
