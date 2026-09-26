-- Platform Device Agent: recovery of an unfinished (PENDING) activation. Forward-only, additive; unused on the VPS edition.
-- activationError: last failure code of the pending attempt (a code such as PLATFORM_UNREACHABLE, never the activation code).
-- activationMaybeBound: true once an attempt for the current requestId may have been bound on Platform (no answer, 5xx,
--   or Platform answered but the local apply failed). While true, only the SAME code may be retried (same
--   requestId/deviceId/key); a different code is refused and, once Platform reports the code expired, recovery
--   (confirmed local reset + new code) is required. Nothing is reset automatically.
ALTER TABLE "PlatformDeviceRegistration"
    ADD COLUMN "activationError" VARCHAR(80),
    ADD COLUMN "activationMaybeBound" BOOLEAN NOT NULL DEFAULT false;
-- A pending attempt from before this migration may have reached Platform: treat it as possibly bound (safe side).
UPDATE "PlatformDeviceRegistration" SET "activationMaybeBound" = true WHERE "status" = 'PENDING' AND "pendingRequestId" IS NOT NULL;
