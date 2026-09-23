-- 0007 Multi Zalo accounts per tenant, account routing rules, per-attempt delivery ledger and
-- atomic daily quota counters. Forward-only. Existing ZaloAccount rows (legacy one-per-installation)
-- are kept with their credentials and become tenant-owned accounts:
--   * tenantId      := Installation.tenantId of the owning installation
--   * dailyQuota    := Installation.dailyQuota (previous effective limit)
--   * status        := mapped from the old free-text status (CONNECTED stays CONNECTED)
--   * isDefault     := true for the earliest account of each tenant only
--   * routing rule  := one installation-scoped rule per account, so a job of installation X keeps
--                      using the account that was provisioned for X (previous behaviour).
-- Tenants without a CrmTenant row are NOT given one here: TenantAccessService treats a missing row
-- as "not CRM-managed" (legacy pilot), so creating rows would block their sending.

-- 1. Enums --------------------------------------------------------------------------------------
CREATE TYPE "ZaloAccountStatus" AS ENUM ('PENDING_LOGIN', 'CONNECTING', 'CONNECTED', 'RELOGIN_REQUIRED', 'PAUSED', 'RATE_LIMITED', 'RESTRICTED', 'DISCONNECTED', 'ERROR', 'REVOKED');
CREATE TYPE "DeliveryAttemptStatus" AS ENUM ('RESERVED', 'IN_FLIGHT', 'SENT', 'REJECTED_BEFORE_SEND', 'UNKNOWN');

-- 2. Installation: composite key used by tenant-scoped composite foreign keys ---------------------
CREATE UNIQUE INDEX "Installation_id_tenantId_key" ON "Installation"("id", "tenantId");

-- 3. ZaloAccount: add nullable columns, backfill, then tighten -----------------------------------
ALTER TABLE "ZaloAccount"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "phoneEnc" TEXT,
  ADD COLUMN "phoneMasked" VARCHAR(20),
  ADD COLUMN "statusNew" "ZaloAccountStatus",
  ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pausedBy" VARCHAR(160),
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dailyQuota" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastActiveAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ZaloAccount" z
SET "tenantId" = i."tenantId",
    "dailyQuota" = GREATEST(i."dailyQuota", 1),
    "timezone" = COALESCE(NULLIF(i."timezone", ''), 'Asia/Ho_Chi_Minh')
FROM "Installation" i
WHERE i."id" = z."installationId";

UPDATE "ZaloAccount" SET "statusNew" = CASE upper(trim("status"))
  WHEN 'CONNECTED' THEN 'CONNECTED'::"ZaloAccountStatus"
  WHEN 'CONNECTING' THEN 'CONNECTING'::"ZaloAccountStatus"
  WHEN 'QR_PENDING' THEN 'PENDING_LOGIN'::"ZaloAccountStatus"
  WHEN 'PENDING_LOGIN' THEN 'PENDING_LOGIN'::"ZaloAccountStatus"
  WHEN 'NEEDS_LOGIN' THEN 'RELOGIN_REQUIRED'::"ZaloAccountStatus"
  WHEN 'RELOGIN_REQUIRED' THEN 'RELOGIN_REQUIRED'::"ZaloAccountStatus"
  WHEN 'RESTRICTED' THEN 'RESTRICTED'::"ZaloAccountStatus"
  WHEN 'ACCOUNT_RESTRICTED' THEN 'RESTRICTED'::"ZaloAccountStatus"
  WHEN 'RATE_LIMITED' THEN 'RATE_LIMITED'::"ZaloAccountStatus"
  WHEN 'REVOKED' THEN 'REVOKED'::"ZaloAccountStatus"
  WHEN 'ERROR' THEN 'ERROR'::"ZaloAccountStatus"
  ELSE 'DISCONNECTED'::"ZaloAccountStatus" END;

-- Earliest account of each tenant becomes that tenant's default.
UPDATE "ZaloAccount" z SET "isDefault" = true
FROM (
  SELECT z2."id", row_number() OVER (PARTITION BY z2."tenantId" ORDER BY i."createdAt", z2."id") AS rn
  FROM "ZaloAccount" z2 JOIN "Installation" i ON i."id" = z2."installationId"
) ranked
WHERE ranked."id" = z."id" AND ranked.rn = 1;

-- Every legacy account was attached to an installation (NOT NULL + FK before this migration),
-- so tenantId is fully backfilled here; the SET NOT NULL fails loudly otherwise.
ALTER TABLE "ZaloAccount" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ZaloAccount" DROP COLUMN "status";
ALTER TABLE "ZaloAccount" RENAME COLUMN "statusNew" TO "status";
ALTER TABLE "ZaloAccount" ALTER COLUMN "status" SET NOT NULL, ALTER COLUMN "status" SET DEFAULT 'PENDING_LOGIN';

-- One account per installation is no longer a rule; the installation link becomes optional and
-- deleting an installation must not delete a tenant-owned account.
ALTER TABLE "ZaloAccount" DROP CONSTRAINT "ZaloAccount_installationId_fkey";
DROP INDEX "ZaloAccount_installationId_key";
ALTER TABLE "ZaloAccount" ALTER COLUMN "installationId" DROP NOT NULL;
ALTER TABLE "ZaloAccount" ADD CONSTRAINT "ZaloAccount_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ZaloAccount_id_tenantId_key" ON "ZaloAccount"("id", "tenantId");
CREATE INDEX "ZaloAccount_tenantId_status_idx" ON "ZaloAccount"("tenantId", "status");
-- At most one live default account per tenant (partial index; not expressible in Prisma schema).
CREATE UNIQUE INDEX "ZaloAccount_one_default_per_tenant" ON "ZaloAccount"("tenantId") WHERE "isDefault" AND "revokedAt" IS NULL;

-- 4. Routing rules ------------------------------------------------------------------------------
CREATE TABLE "ZaloRoutingRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "zaloAccountId" UUID NOT NULL,
    "installationId" UUID,
    "branchId" VARCHAR(80),
    "eventType" VARCHAR(80),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" VARCHAR(160),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ZaloRoutingRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ZaloRoutingRule_tenantId_active_idx" ON "ZaloRoutingRule"("tenantId", "active");
-- No duplicate assignment for the same account/scope (NULLs compare equal; PostgreSQL 15+).
CREATE UNIQUE INDEX "ZaloRoutingRule_scope_key" ON "ZaloRoutingRule"("zaloAccountId", "installationId", "branchId", "eventType") NULLS NOT DISTINCT;
-- Composite FKs: an account and an installation can only be linked inside the same tenant.
ALTER TABLE "ZaloRoutingRule" ADD CONSTRAINT "ZaloRoutingRule_zaloAccountId_tenantId_fkey" FOREIGN KEY ("zaloAccountId", "tenantId") REFERENCES "ZaloAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ZaloRoutingRule" ADD CONSTRAINT "ZaloRoutingRule_installationId_tenantId_fkey" FOREIGN KEY ("installationId", "tenantId") REFERENCES "Installation"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ZaloRoutingRule" ("id", "tenantId", "zaloAccountId", "installationId", "priority", "active", "createdBy")
SELECT gen_random_uuid(), z."tenantId", z."id", z."installationId", 100, true, 'migration:0007'
FROM "ZaloAccount" z WHERE z."installationId" IS NOT NULL;

-- 5. CareJob: branch reference and sticky account selection --------------------------------------
ALTER TABLE "CareJob"
  ADD COLUMN "branchId" VARCHAR(80),
  ADD COLUMN "selectedZaloAccountId" UUID,
  ADD COLUMN "selectedChannel" "ChannelKind";
ALTER TABLE "CareJob" ADD CONSTRAINT "CareJob_selectedZaloAccountId_fkey" FOREIGN KEY ("selectedZaloAccountId") REFERENCES "ZaloAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Delivery attempts (id = deliveryAttemptId = sender idempotency key) -------------------------
CREATE TABLE "DeliveryAttempt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "careJobId" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "zaloAccountId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" "DeliveryAttemptStatus" NOT NULL DEFAULT 'RESERVED',
    "outcomeCode" VARCHAR(80),
    "providerMessageId" VARCHAR(160),
    "quotaScopes" JSONB NOT NULL,
    "quotaReleased" BOOLEAN NOT NULL DEFAULT false,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryAttempt_careJobId_attemptNumber_key" ON "DeliveryAttempt"("careJobId", "attemptNumber");
CREATE INDEX "DeliveryAttempt_zaloAccountId_createdAt_idx" ON "DeliveryAttempt"("zaloAccountId", "createdAt");
-- Anti-duplicate guarantees enforced by the database, not only by the worker:
--   * at most one successful send per care job;
--   * at most one open (reserved / in-flight / unresolved) attempt per care job.
CREATE UNIQUE INDEX "DeliveryAttempt_one_sent_per_job" ON "DeliveryAttempt"("careJobId") WHERE "status" = 'SENT';
CREATE UNIQUE INDEX "DeliveryAttempt_one_open_per_job" ON "DeliveryAttempt"("careJobId") WHERE "status" IN ('RESERVED', 'IN_FLIGHT', 'UNKNOWN');
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_careJobId_fkey" FOREIGN KEY ("careJobId") REFERENCES "CareJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_zaloAccountId_tenantId_fkey" FOREIGN KEY ("zaloAccountId", "tenantId") REFERENCES "ZaloAccount"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_installationId_tenantId_fkey" FOREIGN KEY ("installationId", "tenantId") REFERENCES "Installation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Atomic daily quota counters ----------------------------------------------------------------
CREATE TABLE "DeliveryQuotaCounter" (
    "scope" VARCHAR(16) NOT NULL,
    "scopeId" UUID NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryQuotaCounter_pkey" PRIMARY KEY ("scope", "scopeId", "day"),
    CONSTRAINT "DeliveryQuotaCounter_used_nonnegative" CHECK ("used" >= 0)
);

-- 8. CRM tenant-level cap and timezone ----------------------------------------------------------
ALTER TABLE "CrmTenant"
  ADD COLUMN "tenantDailyQuota" INTEGER,
  ADD COLUMN "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh';
