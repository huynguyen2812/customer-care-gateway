# Báo cáo sửa sau Codex review: Platform Device Agent (2026-09-26, Claude)

- **Trạng thái:** **Đã chạy kỹ thuật** với Platform **GIẢ LẬP** (LOCAL). Chờ Codex review, chưa được anh Huy duyệt.
  **Chưa commit, chưa push, chưa phát hành, chưa upload, không đụng production, không dùng Zalo thật.**
  **KHÔNG production-ready** (chưa E2E Platform thật, chưa cài máy sạch, chưa updater HTTPS thật, chưa pilot Zalo thật).
- **Quyết định của anh Huy (2026-09-26, trong hội thoại):** "bắt buộc ghép Platform mới được gửi tin". Platform cấp mã kích hoạt cho từng khách; bản production `0.3.0-pc` chưa kích hoạt thì không tạo và không gửi tin.
- **Nhánh/working tree:** `D:\DuAn\crm-standalone\customer-care-gateway`, nhánh `feat/standalone-pc-edition`, HEAD `5581357`. Giữ nguyên toàn bộ thay đổi chưa commit của vòng trước; không reset/restore/checkout/stash/clean. Sender không đổi ở vòng này.
- **Không đổi:** cơ chế Client ID/Secret API cục bộ (sinh, hiện một lần, xoay 24 giờ, thu hồi, mã hóa, audit không ghi secret).

## Blocker 1 — Kích hoạt phải nguyên tử: ĐÃ SỬA

**Lỗi cũ:** `activate()` đặt `PlatformDeviceRegistration.status = ACTIVE` rồi mới gọi `applyConfig()` (transaction riêng). `applyConfig` lỗi ⇒ máy ACTIVE mà không có cấu hình, không kích hoạt lại được (`ALREADY_PAIRED`). Ngoài ra khi lỗi, `pendingRequestId` bị xóa nên lần thử lại dùng `requestId` mới.

**Sửa (`src/standalone/platform/platform-device.service.ts`):**
- Gọi Platform (`redeem`) **ngoài** transaction. Sau đó **một** `prisma.$transaction` làm tất cả: xác minh phản hồi và chữ ký cấu hình → đặt ACTIVE (có điều kiện: vẫn PENDING, đúng `deviceId`, đúng `pendingRequestId`) → `applyConfigTx` (lưu `PlatformDesiredConfiguration`, hạn mức, giờ yên tĩnh, gói, phạm vi nguồn, revision) → audit `PLATFORM_DEVICE_PAIRED`. Lỗi bất kỳ ⇒ rollback toàn bộ.
- `applyConfig` tách thành `applyConfigTx(tx, …)` (dùng transaction của người gọi, không tự mở transaction). Đường đồng bộ định kỳ gọi `applyConfig()` = một transaction bao `applyConfigTx`.
- Khóa đồng thời tách khỏi khóa idempotent: `activationLockedUntil` (lease 2 phút) vs `pendingRequestId`. Khi lỗi chỉ nhả lease; `deviceId` + `requestId` giữ nguyên. Nhập lại **đúng mã** ⇒ dùng lại `requestId` (nhận biết bằng `pendingCodeHash` = HMAC khóa máy của mã; mã dạng rõ không bao giờ lưu; xóa khi ACTIVE). Mã khác ⇒ `requestId` mới.

**Bằng chứng (`test/platform-device.integration.spec.ts`, Platform giả):**

| Kiểm thử | Kết quả |
|---|---|
| Cấu hình đầu tiên sai chữ ký ⇒ 503 `CONFIG_SIGNATURE_INVALID`; vẫn PENDING, `everPaired=false`, 0 cấu hình, hạn mức vẫn 30, không có audit PAIRED/CONFIG_APPLIED | PASS |
| Lỗi DB khi áp dụng (trigger QA chặn UPDATE `SourceConnection` — bước cuối) ⇒ 503; đăng ký/cấu hình/hạn mức/gói/chi nhánh đều rollback; `requestId` giữ nguyên; Platform chỉ có 1 thiết bị và cả 2 lần redeem cùng `requestId` | PASS |
| Hai lần kích hoạt đồng thời cùng mã ⇒ đúng một 200, một 409 `ACTIVATION_IN_PROGRESS`; sau hai lần lỗi trước, lần này thành công; 1 thiết bị trên Platform; mọi redeem của mã đó cùng một `requestId` | PASS |
| Mất ACK rồi nhập lại cùng mã ⇒ cùng `deviceId` **và** `requestId`, không có thiết bị thứ hai | PASS |

## Blocker 2 — Phạm vi chi nhánh theo từng nguồn: ĐÃ SỬA

**Lỗi cũ:** `licensedBranches()` lấy **hợp** `allowedBranchIds` của PETCLINIC, B2B_SALE và EXTERNAL.

**Sửa:**
- Hợp đồng đánh giá: `JobScope = { sourceProduct, branchId, eventType }` (`src/standalone/platform/license-gate.service.ts`). Kiểm đúng mục nguồn: nguồn không có mục ⇒ `SOURCE_NOT_LICENSED`; chi nhánh không thuộc mục đó ⇒ `BRANCH_NOT_LICENSED`; thiếu nguồn ⇒ `SOURCE_SCOPE_REQUIRED`.
- Ánh xạ rõ ràng `licensedSourceOf()`: `PETCLINIC_OPERATING`/`PETCLINIC_ESSENTIAL` ⇒ `PETCLINIC`; `B2B_SALE` ⇒ `B2B_SALE`; `EXTERNAL_CONNECTOR` ⇒ `SourceConnection.sourceKind` do chủ doanh nghiệp chọn (bắt buộc khi lưu kết nối, `SOURCE_KIND_REQUIRED`). **Không đoán theo branchId.**
- Nguồn ghi lên từng tin khi tạo (`CareJob.licenseSource`); worker kiểm lại ngay trước gửi bằng đúng nguồn đã ghi. Đổi loại nguồn ⇒ tin QUEUED của loại cũ bị hủy `SOURCE_KIND_CHANGED` (khi lưu kết nối, và worker cũng chặn).
- Cấu hình ký: `sources[].product` phải hợp lệ, **mỗi product một mục** (trùng ⇒ từ chối cả cấu hình).
- Áp dụng tại: lưu kết nối nguồn (tập con của đúng nguồn + `maxBranches`), xem trước/đồng bộ lịch (lý do `BRANCH_NOT_LICENSED` / `SOURCE_KIND_REQUIRED`), tạo CareJob (`care-jobs.service.ts`), worker trước gửi (`care-worker.service.ts` → `TenantAccessService.jobScope`), nhắc lịch, nhắc công nợ (danh sách + xếp hàng). Áp cấu hình: chi nhánh kết nối giao với **mục của đúng loại nguồn**.
- Chính sách thu hẹp (giữ như đã chốt): ngoài phạm vi nguồn/chi nhánh/tính năng ⇒ **hủy** tin chưa gửi ở lần kiểm tra trước gửi; gói/offline/thu hồi ⇒ **giữ** (HOLD).

**Bằng chứng:**

| Kiểm thử | Kết quả |
|---|---|
| PETCLINIC không dùng được `B1` (chỉ cấp cho B2B) — tạo tin, lưu kết nối, gate | PASS |
| B2B không dùng được `CN1` (chỉ cấp cho PETCLINIC) — gate, tạo tin sau khi đổi kết nối sang B2B_SALE, worker | PASS |
| Cùng chuỗi `CN1` ở hai nguồn: installation B2B_SALE ⇒ CANCEL `BRANCH_NOT_LICENSED`, installation PETCLINIC_OPERATING ⇒ SEND | PASS |
| Revision 2 thu hẹp PETCLINIC còn `CN1` (CN2 chuyển sang B2B) ⇒ kết nối PETCLINIC còn `['CN1']` (không lấy CN2 của B2B); tin CN2 đang chờ bị hủy `BRANCH_NOT_LICENSED` trước gửi | PASS |
| Worker dùng nguồn đã ghi trên tin: tin `licenseSource=PETCLINIC` khi kết nối là B2B ⇒ `SOURCE_KIND_CHANGED`; tin `B2B_SALE` + `CN1` ⇒ `BRANCH_NOT_LICENSED` | PASS |
| Kết nối chưa chọn loại (dòng nâng cấp từ 0013) ⇒ giữ tin `SOURCE_SCOPE_REQUIRED`, không đoán | PASS |
| Cấu hình có hai mục cùng product ⇒ bị từ chối | PASS |

## Blocker 3 — Bắt buộc kích hoạt: ĐÃ SỬA

- Chưa có đăng ký, hoặc chỉ có lần thử PENDING ⇒ `PLATFORM_ACTIVATION_REQUIRED` (mode `NOT_ACTIVATED`). Không còn chế độ UNMANAGED được gửi.
- Đã từng ghép (`everPaired`, đặt trong transaction kích hoạt, không bao giờ xóa) ⇒ không bao giờ quay về trạng thái chưa kích hoạt/bỏ qua; kể cả khi đang kích hoạt lại với danh tính mới.
- **Vẫn cho** (có test): thiết lập/đăng nhập, tạo tài khoản nhân viên, xem/xoay/thu hồi Client ID/Secret cục bộ, lưu và xem trước kết nối nguồn, nhập mã kích hoạt, xem trạng thái, đọc lịch sử. Sao lưu/khôi phục chạy bằng script ngoài CRM, không đi qua gate.
- **Không cho** (có test): tạo CareJob (API ký HMAC ⇒ 403), đồng bộ lịch có commit (403), worker gửi (tin được giữ `QUEUED`, 0 DeliveryAttempt). Chỉ worker mới gửi Zalo; không có đường gửi nào khác.
- **Cờ kiểm thử `PLATFORM_LICENSE_BYPASS=1`:** mặc định tắt; chỉ có hiệu lực khi `NODE_ENV` ≠ `production` và máy chưa từng ghép. Dịch vụ Windows luôn chạy `NODE_ENV=production`; bộ cài không ghi cờ này (test quét `packaging/windows`). Request/header/query/body không bật được. Khi bật: màn Kết nối Platform hiện cảnh báo đỏ, `local-status.platform.licenseBypass=true`. Chỉ `test/standalone.integration.spec.ts` bật cờ này (thay cho máy đã kích hoạt; `NODE_ENV=test`).
- UI: màn "Kết nối Platform" đổi nhãn thành "Chưa kích hoạt — chưa gửi được tin"; màn kết nối nguồn có ô bắt buộc "Loại hệ thống nguồn"; khay hệ thống báo "Chưa kích hoạt Platform - chưa gửi tin".
- Tài liệu contract (`platform-device-contract-v1.md`): bỏ "chưa từng ghép vẫn chạy như bản hiện tại"; ghi rõ kích hoạt bắt buộc; bảng phân biệt mã kích hoạt với Client ID/Secret cục bộ; phạm vi theo nguồn; hành vi nguyên tử/idempotent.

## Migration

`prisma/migrations/0015_platform_scope_and_activation` (mới, forward-only, chỉ thêm cột + CHECK):
`PlatformDeviceRegistration.activationLockedUntil`, `pendingCodeHash`, `everPaired` (backfill theo `pairedAt`/trạng thái); `SourceConnection.sourceKind`; `CareJob.licenseSource`.
Tách riêng thay vì sửa `0014` vì `0014` đã áp lên các DB QA (sửa sẽ lệch checksum). Nếu Codex muốn gộp vào 0014 trước khi commit lần đầu, cần tạo lại DB QA.

## Kiểm tra hồi quy (máy anh Huy, QA DB Docker `crm-standalone-qa-pg` 127.0.0.1:55499)

| Kiểm tra | Kết quả |
|---|---|
| `npm test` (unit) | PASS 40/40 |
| `npm run test:platform` (Platform giả) | PASS 16/16 (trước: 13) |
| `npm run test:standalone` | PASS 18/18 |
| `npm run test:integration` (toàn bộ integration cũ, bản VPS) | PASS 117/117 |
| `npm run build` (backend) | PASS |
| `web: npm run build` | PASS |
| `prisma validate` | PASS |
| Migration trên DB QA sạch (`ccg_mig_clean`): 15 migration áp dụng; deploy lần hai "No pending migrations"; status "up to date" | PASS |
| Nâng cấp từ 0013 (`ccg_mig_upgrade`: deploy đến 0013 + dữ liệu `SourceConnection`, rồi deploy 0014+0015); lần hai không còn pending; dòng cũ `sourceKind = NULL`, chi nhánh giữ nguyên | PASS |
| Deploy 0015 lên các DB QA cũ (`ccg_standalone_qa/_it/_ui`, `ccg_platform_it/_ui`) | PASS |
| `git diff --check` | PASS |
| Parse PowerShell `tray.ps1`, `VetclinicCrm.psm1` (còn BOM) | PASS |
| Xem giao diện mới trên trình duyệt (ảnh chụp) | NOT RUN (chỉ build) |
| Build bộ cài thử | NOT RUN (không yêu cầu vòng này; không phát hành) |
| E2E với Platform thật | BLOCKED (Platform chưa hiện thực contract) |
| Cài máy sạch, updater HTTPS thật, Zalo thật | NOT RUN |

## File thay đổi ở vòng này

- Mới: `prisma/migrations/0015_platform_scope_and_activation/migration.sql`, báo cáo này.
- Sửa: `prisma/schema.prisma`; `src/standalone/platform/{license-gate.service,platform-device.service,platform-device.contract,platform-crypto}.ts`; `src/standalone/{source-connector.service,local-status.controller}.ts`; `src/crm/tenant-access.service.ts`; `src/care-jobs/care-jobs.service.ts`; `src/worker/care-worker.service.ts`; `web/src/pages/{PlatformConnection,StandaloneSettings}.tsx`; `web/src/lib/{api,types}.ts`; `packaging/windows/{tray.ps1,VetclinicCrm.psm1}` (chỉ thông báo/ghi chú); `test/{platform-device,standalone}.integration.spec.ts`; `docs/standalone/{platform-device-contract-v1,qa-platform-device-agent-2026-09-26}.md`.

## Rủi ro / việc còn lại

1. **Máy đang chạy 0.2.x nâng lên 0.3.0-pc sẽ dừng gửi tin ngay** cho tới khi nhập mã kích hoạt (đúng quyết định). Cần Platform sẵn sàng cấp mã **trước** khi phát hành bản này, và báo trước cho khách.
2. Kết nối nguồn tạo từ bản cũ chưa có "Loại hệ thống nguồn": chủ doanh nghiệp phải chọn một lần; trong lúc chưa chọn, tin được giữ (`SOURCE_SCOPE_REQUIRED`).
3. Máy lên bản mới bằng tự cập nhật (chưa có `DEVICE_KEY_ENC_KEY`) không kích hoạt được ⇒ không gửi được; phải chạy bộ cài `.exe` mới.
4. Platform phải hiện thực contract (mỗi nguồn một mục chi nhánh; idempotent theo mã + deviceId + requestId) và giao `platform-config-keys.json`.
