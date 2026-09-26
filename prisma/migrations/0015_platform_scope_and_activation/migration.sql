-- Platform Device Agent, fixes after Codex review (forward-only, additive). Empty/unused in the VPS deployment.

-- 1) Atomic, retryable activation. The redeem idempotency key (pendingRequestId + deviceId) is kept across failed
--    attempts for the same code; the concurrency lock is a separate short lease. pendingCodeHash is an HMAC (machine
--    key) of the code being redeemed, only so a retry of the SAME code reuses the same requestId; it is cleared when
--    the device becomes ACTIVE. The activation code itself is never stored.
ALTER TABLE "PlatformDeviceRegistration"
    ADD COLUMN "activationLockedUntil" TIMESTAMP(3),
    ADD COLUMN "pendingCodeHash" VARCHAR(64),
    ADD COLUMN "everPaired" BOOLEAN NOT NULL DEFAULT false;
-- Once paired a PC never falls back to "not activated" (not even with a fresh identity after revoke/unpair).
UPDATE "PlatformDeviceRegistration" SET "everPaired" = true WHERE "pairedAt" IS NOT NULL OR "status" IN ('ACTIVE', 'REVOKED', 'UNPAIRED');
-- Before this migration pendingRequestId doubled as the lock; release it (a new attempt starts a new request).
UPDATE "PlatformDeviceRegistration" SET "pendingRequestId" = NULL WHERE "status" <> 'PENDING';

-- 2) Branch scope is checked per Platform source entry (PETCLINIC / B2B_SALE / EXTERNAL), never as a union.
--    The standalone connector says explicitly which kind of system it reads; existing rows stay NULL until the owner
--    chooses (NULL = no licensed source, nothing can be created or sent for it).
ALTER TABLE "SourceConnection" ADD COLUMN "sourceKind" VARCHAR(20);
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_sourceKind_check" CHECK ("sourceKind" IS NULL OR "sourceKind" IN ('PETCLINIC', 'B2B_SALE', 'EXTERNAL'));
-- Licensed source recorded on each job at creation, so the pre-send check uses the same source entry.
ALTER TABLE "CareJob" ADD COLUMN "licenseSource" VARCHAR(20);
ALTER TABLE "CareJob" ADD CONSTRAINT "CareJob_licenseSource_check" CHECK ("licenseSource" IS NULL OR "licenseSource" IN ('PETCLINIC', 'B2B_SALE', 'EXTERNAL'));
