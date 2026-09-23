ALTER TYPE "SourceProduct" ADD VALUE IF NOT EXISTS 'PETCLINIC_OPERATING';

CREATE TABLE "PetclinicConnection" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "apiBaseUrl" TEXT NOT NULL,
    "apiTokenEnc" TEXT NOT NULL,
    "apiTenantId" VARCHAR(160) NOT NULL,
    "allowedBranchIds" TEXT[] NOT NULL,
    "pilotAllowedPhoneHashes" TEXT[] NOT NULL,
    "appointmentsPath" TEXT NOT NULL DEFAULT '/clinic-service/api/v1/clinic/appointments',
    "reminderLeadMinutes" INTEGER NOT NULL DEFAULT 1440,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" VARCHAR(40),
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PetclinicConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PetclinicConnection_installationId_key" ON "PetclinicConnection"("installationId");
ALTER TABLE "PetclinicConnection" ADD CONSTRAINT "PetclinicConnection_installationId_fkey"
  FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
