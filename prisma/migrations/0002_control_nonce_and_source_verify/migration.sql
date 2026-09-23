ALTER TABLE "Installation" ADD COLUMN "sourceVerifyUrl" TEXT;

CREATE TABLE "ControlNonce" (
    "clientId" VARCHAR(80) NOT NULL,
    "nonce" VARCHAR(80) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ControlNonce_pkey" PRIMARY KEY ("clientId", "nonce")
);

CREATE INDEX "ControlNonce_seenAt_idx" ON "ControlNonce"("seenAt");
