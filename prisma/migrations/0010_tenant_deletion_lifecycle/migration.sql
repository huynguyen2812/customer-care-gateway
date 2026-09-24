-- Forward-only: vòng đời chấm dứt/xóa tenant do Platform điều phối (tenant.deletion_requested →
-- tenant.deletion_cancelled | tenant.purge_requested). CRM không tự xóa theo lịch riêng.

-- Khóa tenant trong thời gian chờ xóa. Cột này đi qua đúng cổng entitlementUsable() đang dùng cho
-- đăng nhập, tạo tác vụ và worker, nên khóa có hiệu lực ở mọi đường vào mà không cần kiểm tra riêng.
ALTER TABLE "CrmTenant" ADD COLUMN "deletionRequestId" UUID;
ALTER TABLE "CrmTenant" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

-- Sổ theo dõi xóa, KHÔNG có khóa ngoại tới CrmTenant: bản ghi phải tồn tại sau khi purge để Platform
-- retry cùng requestId vẫn nhận lại đúng kết quả và để đối soát. Không chứa dữ liệu cá nhân.
CREATE TABLE "CrmTenantDeletion" (
  "requestId"        UUID         NOT NULL,
  "platformTenantId" UUID         NOT NULL,
  "status"           VARCHAR(20)  NOT NULL,
  "requestedAt"      TIMESTAMP(3) NOT NULL,
  "scheduledPurgeAt" TIMESTAMP(3) NOT NULL,
  "retentionDays"    INTEGER      NOT NULL,
  "exportChecksum"   VARCHAR(64),
  "cancelledAt"      TIMESTAMP(3),
  "purgeStartedAt"   TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "purgeAttempts"    INTEGER      NOT NULL DEFAULT 0,
  "deletedCounts"    JSONB,
  "errorCode"        VARCHAR(80),
  "errorMessage"     VARCHAR(500),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmTenantDeletion_pkey" PRIMARY KEY ("requestId"),
  CONSTRAINT "CrmTenantDeletion_status_check" CHECK ("status" IN ('PENDING', 'CANCELLED', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

CREATE INDEX "CrmTenantDeletion_platformTenantId_idx" ON "CrmTenantDeletion"("platformTenantId");
-- Tối đa một yêu cầu xóa đang mở cho mỗi tenant.
CREATE UNIQUE INDEX "CrmTenantDeletion_open_per_tenant_key" ON "CrmTenantDeletion"("platformTenantId")
  WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
