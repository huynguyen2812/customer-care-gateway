# Báo cáo: Platform Device Agent cho VETCLINIC CRM PC (2026-09-26, Claude)

> **Đã được thay thế một phần** bởi [qa-platform-device-agent-fix-codex-review-2026-09-26.md](qa-platform-device-agent-fix-codex-review-2026-09-26.md):
> chế độ "Chưa được Platform quản lý" (UNMANAGED) **đã bỏ** — anh Huy chốt kích hoạt là bắt buộc để gửi tin;
> kích hoạt nay nguyên tử; phạm vi chi nhánh kiểm theo từng nguồn. Các dòng nhắc tới UNMANAGED bên dưới là lịch sử.

- **Trạng thái:** **Đã chạy kỹ thuật** với Platform **GIẢ LẬP** (LOCAL). Chưa được anh Huy duyệt, chưa Codex review.
  **Chưa commit, chưa push, chưa phát hành, chưa upload, không đụng production.**
  **KHÔNG production-ready** vì chưa có E2E với Platform thật, chưa cài máy sạch, chưa có updater HTTPS thật, chưa pilot Zalo thật.
- **Quyết định của anh Huy (2026-09-26, trong hội thoại):** chuyển sang hướng "Platform cấp phép bằng mã kích hoạt". Quyết định này thay cho quyết định 2026-09-25 "tải tự do, không mã kích hoạt".
  - File cài vẫn tải tự do.
  - Muốn được quản lý và gửi theo giấy phép thì phải ghép Platform.
  - Chưa ghép thì chạy chế độ "Chưa được Platform quản lý" để pilot/chuyển đổi.

## Bước 0 (trước khi sửa)

| Repo | Nhánh | HEAD | Trạng thái |
|---|---|---|---|
| `D:\DuAn\crm-standalone\customer-care-gateway` | `feat/standalone-pc-edition` | `5581357` | 19 file M + các file mới của bản PC (bước 2–4), `git diff --check` PASS |
| `D:\DuAn\crm-standalone\vetclinic-zalo-sender` | `feat/standalone-pc-edition` | `fda67b3c` | 2 M + 4 file mới, `git diff --check` PASS |

- Trạng thái khớp báo cáo trước; không có thay đổi của người khác chồng lấn.
- Không reset/restore/stash, không đụng `D:\DuAn\customer-care-gateway`.
- Task B2B/Platform chưa bàn giao contract thiết bị nào (đã tìm trong AI-SYNC/docs) ⇒ em viết contract **đề xuất**.

## Thay đổi (chỉ repo CRM; Sender không đổi ở vòng này)

| File | Nội dung |
|---|---|
| `prisma/migrations/0014_platform_device_agent/` + `schema.prisma` | `PlatformDeviceRegistration` (1 dòng, CHECK id=1, deviceId unique, trạng thái PENDING/ACTIVE/REVOKED/UNPAIRED, offlineGraceUntil…) và `PlatformDesiredConfiguration` (unique (deviceId, revision), payload đã xác minh, hash, chữ ký, trạng thái áp dụng). Chỉ thêm, forward-only |
| `src/standalone/platform/platform-device.contract.ts` | Kiểu dữ liệu + chuỗi ký của contract đề xuất; interface `PlatformDeviceApi` |
| `src/standalone/platform/platform-crypto.ts` | Khóa thiết bị Ed25519 (khóa bí mật mã hóa bằng `DEVICE_KEY_ENC_KEY` riêng của máy); kiểm cấu hình ký (khóa, chữ ký, thiết bị, sản phẩm, thời gian, dữ liệu, grace ≤ 72h) |
| `src/standalone/platform/platform-device.client.ts` | Client HTTPS (URL chỉ lấy từ cấu hình phát hành, không redirect, timeout, giới hạn kích thước) |
| `src/standalone/platform/platform-device.service.ts` | Kích hoạt (claim nguyên tử, idempotent khi mất ACK, không lưu mã), áp cấu hình (revision tăng đơn điệu, trùng thì bỏ qua), đồng bộ + heartbeat, ngắt ghép nối, thông tin build |
| `src/standalone/platform/license-gate.service.ts` | Luật giấy phép: UNMANAGED / MANAGED; offline 72h; gói; thu hồi; ngắt ghép; khóa không mở được; phạm vi chi nhánh/tính năng |
| `src/standalone/platform/platform-device.controller.ts` | `GET /crm/local/platform`, `POST …/activate` (chủ DN), `…/sync`, `…/unpair` (gõ xác nhận), `GET /crm/local/version` |
| `src/standalone/platform/platform-sync.runtime.ts` | Worker đồng bộ 30 giây sau khi chạy, sau đó mỗi 15 phút |
| `src/crm/tenant-access.service.ts` | Gọi LicenseGate (chỉ có ở bản PC; bản VPS không có nên không đổi): lỗi giấy phép ⇒ **HOLD**; ngoài phạm vi chi nhánh/tính năng ⇒ **CANCEL** |
| `src/care-jobs/care-jobs.service.ts`, `src/worker/care-worker.service.ts` | Truyền phạm vi (branchId, eventType) vào gate |
| `src/standalone/source-connector.service.ts` | Không cho cấu hình chi nhánh ngoài danh sách Platform; xem trước/đồng bộ gắn lý do `BRANCH_NOT_LICENSED` |
| `src/standalone/local-status.controller.ts` | Thêm tóm tắt giấy phép (chỉ mã/thời điểm) + phiên bản cho khay/chẩn đoán |
| `src/standalone/standalone-app.module.ts` | Đăng ký các thành phần trên (không thêm endpoint quản trị VPS) |
| `web/src/pages/PlatformConnection.tsx` + `api.ts`, `types.ts`, `routes.ts`, `App.tsx`, `Sidebar.tsx` | Màn "Kết nối Platform" riêng: chưa kích hoạt / đã kích hoạt / tạm dừng, phiên bản + commit. **Khu "Khóa API của doanh nghiệp" giữ nguyên, không trộn** |
| `packaging/windows/VetclinicCrm.psm1` | Env `DEVICE_KEY_ENC_KEY`, `PLATFORM_DEVICE_API_URL` (hằng số phát hành, đề xuất), `PLATFORM_CONFIG_PUBLIC_KEYS` (file đi kèm bộ cài), `VC_BUILD_INFO_FILE`; `Add-VcMissingSecrets` |
| `packaging/windows/install.ps1` / `update.ps1` | Sinh `DEVICE_KEY_ENC_KEY` (**không** nằm trong gói khóa sao lưu) / bổ sung secret mới khi cập nhật |
| `packaging/windows/build.ps1` / `release.ps1` | Đóng gói `platform-config-keys.json` nếu có; manifest thêm `build {crmCommit, senderCommit, builtAt, dirty}`; **từ chối phát hành từ source chưa commit** (chỉ cho bản thử `-AllowDirty` với hậu tố `-dev`/`-qa`) |
| `docs/standalone/platform-device-contract-v1.md` | Contract đề xuất cho Platform |
| `docs/standalone/chuyen-doi-vps-sang-pc.md` | Runbook chuyển đổi 12 bước (chưa chạy bước production nào) |
| `test/platform-device.integration.spec.ts`, `test/platform-config.spec.ts`, `package.json` (`test:platform`) | Test mới |

**Khóa API cục bộ (Client ID/Secret) giữ nguyên hoàn toàn.** CRM PC tự sinh, secret hiện một lần, lưu mã hóa, có xoay/thu hồi, có 24 giờ chuyển tiếp, có audit và Source Connector vẫn dùng khóa này. Platform không nhận khóa này.

## Kết quả kiểm thử (Platform giả = test server nội bộ theo contract đề xuất; Zalo = kênh MOCK)

| # | Yêu cầu | Kết quả |
|---|---|---|
| 1–3 | Khóa API cục bộ vẫn chạy: hiện 1 lần, danh sách không trả secret, xoay (khóa cũ còn 24h) / thu hồi | PASS |
| 4 | Mã kích hoạt: sai định dạng, không tồn tại, hết hạn, sai sản phẩm bị từ chối; hợp lệ thì ghép được; không lưu mã (quét DB + audit) | PASS (sai tenant: Platform giả chưa mô phỏng; đã có mã lỗi `ACTIVATION_WRONG_TENANT` trong contract) |
| 5 | 2 yêu cầu kích hoạt đồng thời chỉ 1 thành công; mã đã dùng không ghép được máy thứ hai (409); mất ACK thì thử lại dùng đúng thiết bị cũ, không tạo thiết bị trùng | PASS |
| 6 | Cấu hình sai chữ ký / khóa lạ / thiết bị khác / sản phẩm khác / hết hạn / phát hành "từ tương lai" / dữ liệu sai bị từ chối | PASS (integration + unit) |
| 7 | Revision cũ bị từ chối (chống hạ cấp); trùng revision cùng nội dung được bỏ qua | PASS |
| 8 | Cấu hình mới áp đúng chi nhánh, hạn mức, giờ yên tĩnh | PASS |
| 9 | Heartbeat chỉ có số liệu tổng hợp: quét mọi request gửi Platform không có SĐT, tên, clientId/secret, private key, tenantId cục bộ | PASS |
| 10 | Mất mạng: < 72h vẫn chạy và Platform không phản hồi thì không gia hạn; > 72h giữ tin (không xóa), không tạo tin mới, vẫn xem lịch sử; mạng trở lại thì gửi tiếp | PASS |
| 11 | Gói SUSPENDED/EXPIRED và thiết bị REVOKED: giữ tin, không xóa, có audit | PASS |
| 12 | Gói trở lại ACTIVE thì hoạt động lại (tạo tin + gửi qua MOCK) | PASS |
| 13 | Chi nhánh ngoài phạm vi bị chặn khi tạo tin, khi gửi, khi cấu hình nguồn; tin không có chi nhánh bị chặn | PASS |
| 14 | Nguồn không phản hồi thì không gửi | PASS (bộ test standalone sẵn có) |
| 15 | Tin trễ quá 12 giờ không gửi dồn | PASS (bộ test standalone sẵn có) |
| 16 | Khôi phục sang máy khác (khóa máy khác) ⇒ `DEVICE_REPAIR_REQUIRED`, phải ghép lại; gói khóa sao lưu không chứa khóa thiết bị; mã kích hoạt không bao giờ được lưu | PASS (integration + kiểm mã nguồn) |
| — | Ngắt ghép nối (bắt gõ xác nhận) ⇒ không quay về UNMANAGED, vẫn dừng gửi | PASS |
| — | `local-status` (khay) không lộ tên DN/deviceId/clientId | PASS |
| 17 | Bản VPS không đổi: integration cũ | PASS 117/117 |
| 18 | TypeScript backend + web, build backend + web | PASS |
| 18 | Migration 0014 deploy 2 lần (không còn pending) trên 3 DB QA | PASS |
| 18 | Parse + BOM 12 script PowerShell; bản cài cũ (thiếu secret mới) vẫn khởi động được | PASS (em tìm và sửa 1 lỗi: strict mode làm dịch vụ không khởi động được khi thiếu `DEVICE_KEY_ENC_KEY`) |
| 18 | `release.ps1` từ chối source chưa commit và version thiếu `-dev` | PASS |
| 18 | Build đóng gói `0.3.0-dev` (build lại từ đầu, bộ cài 173 MB, manifest có `build.crmCommit/senderCommit/dirty=true`) | PASS (bản thử) |
| 19 | Giao diện 1440×900 và 1280×800: chưa kích hoạt → nhập mã → đã kích hoạt; không tràn ngang; khu Khóa API vẫn riêng | PASS (Platform giả chạy cục bộ, cổng 47101; không đụng bản anh Huy đang cài ở 47100) |
| 20 | Không Zalo thật, không gửi tin thật | Đúng: chỉ kênh MOCK |

**Tổng test:** unit 40/40, integration cũ 117/117, bản PC 18/18, Platform agent 13/13.

## Đóng gói

`release.ps1 -Version 0.3.0-dev -AllowDirty` là **bản thử**, không phải bản phát hành. Manifest ghi `dirty=true`, **không upload**; file nằm tại `D:DuAncrm-standaloneuildelease .3.0-dev`.
**Phiên bản đề xuất khi phát hành thật** (sau khi commit sạch + có khóa Platform): `0.3.0-pc`.
`platform-config-keys.json` chưa có vì Platform chưa giao khóa, nên bản này chưa ghép Platform được (đã có thông báo rõ trên màn hình).

## NOT RUN / BLOCKED

- **BLOCKED:** E2E với Platform thật (task B2B chưa hiện thực contract, chưa giao khóa công khai ký cấu hình).
- **NOT RUN:** cài máy Windows sạch; updater HTTPS thật (chưa upload, cần anh Huy duyệt); pilot Zalo thật; khởi động lại Windows.
- **NOT RUN:** chuyển đổi VPS (chỉ viết runbook).

## Rủi ro / việc còn lại

1. **Platform:** hiện thực contract (mục 7 của `platform-device-contract-v1.md`), giao `platform-config-keys.json` và URL chính thức.
2. **Nâng cấp từ 0.2.x:**
   - Máy lên bản mới **bằng tự cập nhật** chạy `update.ps1` của bản cũ, nên chưa có `DEVICE_KEY_ENC_KEY`. CRM vẫn chạy (UNMANAGED) nhưng kích hoạt Platform báo "Cần chạy bộ cài phiên bản mới".
   - Chạy bộ cài `.exe` mới thì sẽ bổ sung khóa này.
   - Hiện chỉ có máy dev của anh Huy đang chạy 0.2.1.
3. **Chế độ UNMANAGED:** ai tải bộ cài cũng dùng được chế độ này (dùng cho pilot/chuyển đổi, có gắn nhãn rõ). Nếu muốn bắt buộc ghép Platform mới được gửi tin, cần quyết định thêm (một cờ trong bản phát hành).
4. **Khóa bí mật thiết bị:** được mã hóa bằng một khóa riêng của máy nằm trong kho DPAPI, **không** lưu trực tiếp trong DPAPI. Lý do: tiến trình dịch vụ không ghi được kho DPAPI. Hệ quả giống nhau: không có khóa máy thì không mở được. Em ghi rõ để Codex duyệt.
5. **Nhiều thiết bị cho một doanh nghiệp:** schema giữ `deviceId` unique để mở rộng sau; hiện CHECK id=1 cho phép 1 PC chính.
