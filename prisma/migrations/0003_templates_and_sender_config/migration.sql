ALTER TABLE "ZaloAccount" ADD COLUMN "senderBaseUrl" TEXT;
ALTER TABLE "ZaloAccount" ADD COLUMN "senderClientId" VARCHAR(100);

CREATE TABLE "MessageTemplate" (
  "id" UUID NOT NULL,
  "installationId" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "allowedVariables" TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MessageTemplate_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MessageTemplate_installationId_code_key" ON "MessageTemplate"("installationId", "code");
