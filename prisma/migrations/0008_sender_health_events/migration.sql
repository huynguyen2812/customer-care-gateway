-- Sender v2 health callback (forward-only). eventId = khóa idempotent; FK kép (account, tenant)
-- bảo đảm sự kiện chỉ gắn với account của đúng tenant.
CREATE TABLE "SenderHealthEvent" (
    "eventId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "zaloAccountId" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(80),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SenderHealthEvent_pkey" PRIMARY KEY ("eventId"),
    CONSTRAINT "SenderHealthEvent_status_check" CHECK ("status" IN ('CONNECTED','DISCONNECTED','RELOGIN_REQUIRED','RESTRICTED','PAUSED'))
);
CREATE INDEX "SenderHealthEvent_zaloAccountId_occurredAt_idx" ON "SenderHealthEvent"("zaloAccountId", "occurredAt");
ALTER TABLE "SenderHealthEvent" ADD CONSTRAINT "SenderHealthEvent_zaloAccountId_tenantId_fkey"
  FOREIGN KEY ("zaloAccountId", "tenantId") REFERENCES "ZaloAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
