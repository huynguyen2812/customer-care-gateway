ALTER TABLE "PetclinicConnection"
  ALTER COLUMN "apiTokenEnc" DROP NOT NULL,
  ADD COLUMN "sourceProduct" "SourceProduct" NOT NULL DEFAULT 'PETCLINIC_OPERATING',
  ADD COLUMN "credentialKeyId" VARCHAR(80),
  ADD COLUMN "credentialExpiresAt" TIMESTAMP(3),
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "sourceInstallationId" UUID,
  ADD COLUMN "sourceRevision" INTEGER,
  ADD COLUMN "contractVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "CareJob"
  ADD COLUMN "sourceAppointmentAt" TIMESTAMP(3),
  ADD COLUMN "sourceRevision" VARCHAR(100);

CREATE INDEX "PetclinicConnection_sourceProduct_active_idx"
  ON "PetclinicConnection"("sourceProduct", "active");

CREATE UNIQUE INDEX "PetclinicConnection_sourceInstallationId_key"
  ON "PetclinicConnection"("sourceInstallationId");

ALTER TABLE "PlatformEvent"
  ADD COLUMN "payloadHash" CHAR(64);
