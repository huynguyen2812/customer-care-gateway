# Báo cáo sửa thời hạn giấy phép (Codex review vòng 2) — VETCLINIC CRM PC (2026-09-26, Claude)

> **ĐÃ BỊ THAY THẾ một phần (2026-09-26)** bởi [qa-platform-lease-shared-contract-2026-09-26.md](qa-platform-lease-shared-contract-2026-09-26.md): quy tắc "cửa sổ gia hạn trực tuyến 60 phút / Platform gia hạn mỗi 30 phút / ~48 cấu hình mỗi ngày" **chưa được duyệt, đã bỏ**. PC nay chỉ thực thi `expiresAt` và `plan.validUntil` đã ký theo contract chung. Phần kiểm `offlineGraceHours` (0–72, 0 giữ nguyên) và "200/replay không gia hạn" vẫn giữ.

- **Trạng thái:** **Đã chạy kỹ thuật** với Platform **GIẢ LẬP** (LOCAL). Chờ Codex review, chưa được anh Huy duyệt.
  **Chưa commit, chưa push, chưa build bộ cài, chưa upload, không deploy, không migration production, không Zalo thật.**
- **Repo:** `D:\DuAn\crm-standalone\customer-care-gateway`, nhánh `feat/standalone-pc-edition`, HEAD `5581357`. Trước khi sửa: 34 mục chưa commit (của các vòng trước), giữ nguyên; không reset/restore/stash/clean. Không sửa repo Platform, Sender hay CRM VPS. Cơ chế Client ID/Secret cục bộ không đổi.
- **Không có migration mới** ở vòng này (schema không đổi).

## Lỗi 1 — Vẫn gửi được khi cấu hình ký đã hết hạn

**Nguyên nhân:**
1. `verifyConfig` chỉ kiểm `expiresAt` lúc **nhận** cấu hình; `LicenseGateService.evaluate` không kiểm lại khi tạo/gửi tin.
2. `PlatformDeviceService.sync` đặt lại `lastValidatedAt` và `offlineGraceUntil = now + 72 h` sau **mọi** phản hồi 200 không bị từ chối — kể cả không có cấu hình, hoặc gửi lại đúng revision cũ. Một Platform chỉ trả 200 (hoặc bị giả mạo trả 200) là kéo dài quyền gửi vô hạn.

**Sửa:**
- `license-gate.service.ts`: hàm thuần `licenceWindow(row)` tính thời hạn **chỉ từ cấu hình đã xác minh chữ ký** (dòng `PlatformDesiredConfiguration` mới nhất):
  - `configExpiresAt = expiresAt` (đã ký);
  - `planValidUntil = plan.validUntil` (đã ký);
  - `offlineUntil = mốc gốc + 60 phút + offlineGraceHours`, với mốc gốc = sớm hơn giữa `issuedAt` (đã ký) và lúc áp dụng revision đó lần đầu (gửi lại không đổi mốc);
  - `until` = sớm nhất của ba mốc.
- `evaluate()` (dùng cho mọi đường tạo tin, đồng bộ lịch có commit, nhắc công nợ và worker ngay trước khi gửi) chặn khi `now >= mốc`: `PLAN_EXPIRED` → `PLATFORM_CONFIG_EXPIRED` → `PLATFORM_OFFLINE_GRACE_EXPIRED`. Cả ba đều **HOLD** (không hủy, không xóa). Không còn đọc cột `offlineGraceUntil` để quyết định.
- `platform-device.service.ts`:
  - `sync()` **không** còn đụng `lastValidatedAt` / `offlineGraceUntil`; chỉ ghi `lastSyncAt` / `lastSyncError` (và REVOKED nếu Platform báo).
  - Chỉ `applyConfigTx` khi áp dụng **revision mới** mới đặt `lastValidatedAt` và cột hiển thị `offlineGraceUntil = until`. Gửi lại cùng revision trả `DUPLICATE` trước khi ghi gì.
  - Kích hoạt không tự đặt thời hạn nữa; thời hạn đến từ cấu hình đầu tiên trong cùng transaction.
  - Gia hạn định kỳ (cùng phạm vi, chỉ khác revision/issuedAt/expiresAt) không ghi audit từng lần (so sánh phạm vi bằng `canonicalJson`); giữ 200 revision gần nhất.
- `status()` / `local-status`: trả `licensedUntil`, `configExpiresAt`, `offlineGraceUntil` tính từ cấu hình ký. Màn Kết nối Platform hiện "Được gửi tin đến" và "Cấu hình Platform hết hạn"; thêm thông báo `PLATFORM_CONFIG_EXPIRED`.

**Trước / sau:**

| Tình huống | Trước | Sau |
|---|---|---|
| Cấu hình ký hết hạn, còn "72 giờ offline" | Vẫn tạo và gửi tin | HOLD `PLATFORM_CONFIG_EXPIRED`, không gọi Sender |
| Sync 200 không có cấu hình | +72 giờ mỗi lần | Không đổi gì |
| Gửi lại cùng revision | +72 giờ mỗi lần | `DUPLICATE`, không đổi gì |
| Cấu hình sai chữ ký / revision cũ / cùng revision khác nội dung | Không gia hạn (đã đúng) | Không gia hạn (có test lại) |
| Revision mới hợp lệ | Gia hạn | Gia hạn đúng `min(expiresAt, plan.validUntil, mốc gốc + 60 phút + grace)` |

## Lỗi 2 — `offlineGraceHours = 0` bị đổi thành 72

**Nguyên nhân:** `Number(p.offlineGraceHours) || 72` biến `0` thành `72`, và thiếu/`null`/chuỗi rỗng/`NaN` cũng thành 72 (mở rộng quyền).

**Sửa (`platform-crypto.ts`):** `isValidOfflineGraceHours()` — bắt buộc là **số nguyên 0–72**. Thiếu, `null`, chuỗi (kể cả `"24"`), âm, số lẻ, > 72, boolean, object ⇒ **từ chối cả cấu hình** (`CONFIG_MALFORMED`); không điền mặc định, không cắt. `NaN`/`Infinity` không đi qua JSON được (thành `null`) nên cũng bị từ chối. Nếu dòng đã lưu có giá trị sai (chỉ có thể do sửa DB tay), `licenceWindow` coi như không có thời gian (đóng an toàn).

**Ngữ nghĩa 0 giờ (ghi trong contract mục 4.1):** tách **cửa sổ gia hạn trực tuyến** (hằng số contract v1: 60 phút) khỏi **thời gian thêm khi mất kết nối** (`offlineGraceHours`). PC đang kết nối nhận revision mới ít nhất mỗi 30 phút nên không bao giờ chạm mốc. `0` = không có thời gian thêm: mất kết nối thì dừng tối đa 60 phút sau revision cuối. Như vậy xác thực trực tuyến hợp lệ **không** vô dụng.

## Yêu cầu mới cho phía Platform (đã ghi trong contract mục 3.2, 4.1, 7)

1. Trong `sync`, nếu cấu hình mới nhất của thiết bị đã phát hành quá **30 phút** hoặc `expiresAt` còn dưới 12 giờ ⇒ phát hành **revision mới** (cùng phạm vi, `issuedAt`/`expiresAt` mới) và trả trong `config`. Đây là cách duy nhất để gia hạn; không cần endpoint hay loại chữ ký mới.
2. `offlineGraceHours` luôn là số nguyên 0–72 (đề xuất mặc định 72).
3. `expiresAt` đề xuất `issuedAt + 7 ngày`, không vượt `plan.validUntil`.

**Điểm cần Codex/Platform chốt:** tần suất revision gia hạn (~48 revision/ngày/thiết bị khi luôn online). PC chịu được (giữ 200 dòng gần nhất, không audit từng lần gia hạn). Nếu Platform muốn thưa hơn, chỉ cần tăng hằng số `ONLINE_RENEWAL_WINDOW_MINUTES` ở **cả hai phía** trong contract v1 — nhưng khi đó ý nghĩa "0 giờ" sẽ là "dừng tối đa bằng cửa sổ đó".

## File sửa ở vòng này

- `src/standalone/platform/platform-device.contract.ts` — hằng số `ONLINE_RENEWAL_WINDOW_MINUTES`, ghi chú trường `offlineGraceHours`.
- `src/standalone/platform/platform-crypto.ts` — `isValidOfflineGraceHours`, bỏ `|| 72`.
- `src/standalone/platform/license-gate.service.ts` — `licenceWindow`, `LicenceWindow`, `effectiveRow`, kiểm ba mốc trong `evaluate`, trả `window`.
- `src/standalone/platform/platform-device.service.ts` — `sync` không gia hạn; `applyConfigTx` đặt thời hạn khi có revision mới; không audit gia hạn thuần; dọn revision cũ; `status` trả thời hạn đã ký.
- `src/standalone/local-status.controller.ts` — `licensedUntil`, `offlineGraceUntil` từ cấu hình ký.
- `web/src/pages/PlatformConnection.tsx`, `web/src/lib/{api,types}.ts` — nhãn và thông báo.
- `test/platform-config.spec.ts`, `test/platform-device.integration.spec.ts` — test mới (bên dưới).
- `docs/standalone/platform-device-contract-v1.md` — mục 3.2 (gia hạn), 4 (kiểm `offlineGraceHours`), 4.1 (thời hạn quyền gửi), 5, 7.

## Kiểm thử (em tự chạy trong vòng này, 2026-09-26)

Thời gian mô phỏng bằng tham số `now` của `evaluate()` và bằng cách dời mốc thời gian của cấu hình mới nhất trong DB QA (không chờ). Sender được theo dõi bằng `jest.spyOn(ChannelRouterService.send)` (kênh MOCK).

Trước mỗi lệnh có TRUNCATE, lệnh kiểm tra `DATABASE_URL` phải là `127.0.0.1:55499` và tên DB `ccg_platform_it` / `ccg_standalone_it` / `ccg_standalone_qa` (container QA `crm-standalone-qa-pg`); không in URL có mật khẩu. Không dùng DB bản PC anh Huy đang cài hay production.

| # yêu cầu | Test | Kết quả |
|---|---|---|
| 1, 9, 12 | `expiry 1/9/12`: cấu hình/gói/offline đều còn ⇒ gửi, Sender được gọi đúng 1 lần; `until` = min của 3 mốc (so khớp chính xác) | PASS |
| 2, 12 | `expiry 2/…`: cấu hình hết hạn, offline còn ⇒ HOLD `PLATFORM_CONFIG_EXPIRED`, Sender **không** được gọi, không thêm DeliveryAttempt, tạo tin mới bị chặn | PASS |
| 6 | Sync 200 không có cấu hình ⇒ `lastConfigRevision`, `lastValidatedAt`, cột `offlineGraceUntil`, `until`, mã chặn **không đổi** | PASS |
| 7 | Gửi lại cùng revision 2 lần ⇒ `DUPLICATE`, không đổi | PASS |
| 8 | Revision mới sai chữ ký / revision cũ / cùng revision khác nội dung ⇒ không đổi, `lastSyncError=CONFIG_REJECTED`, tin vẫn HOLD | PASS |
| 9 | Revision mới hợp lệ ⇒ mở lại đúng thời hạn; tin đang giữ được gửi | PASS |
| 13 | Khi đang bị chặn: xem/xoay/thu hồi Client ID/Secret cục bộ, khóa mới vẫn xác thực (403 chứ không 401), xem lịch sử, xem trước nguồn | PASS |
| 3, 5 | Gói hết trước cấu hình: `until = plan.validUntil`; 1 ms trước ⇒ cho, đúng mốc ⇒ `PLAN_EXPIRED`; worker giữ tin | PASS |
| 5 | Cấu hình hết trước: 1 ms trước ⇒ cho, đúng mốc ⇒ `PLATFORM_CONFIG_EXPIRED` | PASS |
| 4, 5, 12 | Offline hết trước (grace 1 h): đúng mốc ⇒ `PLATFORM_OFFLINE_GRACE_EXPIRED`; Platform không truy cập được ⇒ worker giữ tin, Sender không được gọi | PASS |
| 9 | Có lại revision mới ⇒ hai tin đang giữ được gửi; tin trễ 13 giờ vẫn bị hủy `EXPIRED_WHILE_OFFLINE` | PASS |
| 10 | `offlineGraceHours = 0` lưu đúng 0; `offlineUntil = mốc gốc + 60 phút` chính xác; 1 ms trước ⇒ cho, đúng mốc ⇒ chặn; quá 60 phút ⇒ chặn; revision gia hạn ⇒ mở lại và không ghi thêm audit | PASS |
| 11 | Revision mới có `offlineGraceHours` thiếu / `null` / `"24"` / `-1` / `73` / `1.5` ⇒ bị từ chối, thời hạn không đổi | PASS |
| 11 (unit) | `verifyConfig`: giữ 0/1/24/72; từ chối thiếu, null, `"24"`, `"0"`, -1, 73, 500, 1.5, true, {}, [] | PASS |
| unit | `licenceWindow`: công thức, lấy mốc sớm nhất, mốc gốc lấy thời điểm sớm hơn, giá trị lưu sai ⇒ đóng an toàn | PASS |
| 14 | Toàn bộ test cũ trong `platform-device.integration.spec.ts`: bắt buộc kích hoạt, cờ bypass, kích hoạt nguyên tử (sai chữ ký, lỗi DB rollback, đồng thời, mất ACK), phạm vi theo nguồn, heartbeat, cấu hình ký, gói SUSPENDED/EXPIRED, REVOKED, khôi phục máy khác/ngắt ghép, local-status | PASS |

**Tổng hợp lần chạy của vòng này:**

| Lệnh | Kết quả |
|---|---|
| `npm test` (unit) | PASS 44/44 |
| `npm run test:platform` | PASS 19/19 |
| `npm run test:standalone` | PASS 18/18 |
| `npm run test:integration` (bản VPS) | PASS 117/117 |
| `npm run build` (backend) | PASS |
| `web: npm run build` | PASS |
| `prisma validate` / `migrate status` (QA) | PASS / up to date |
| `git diff --check` | PASS |
| Xem giao diện trên trình duyệt | NOT RUN (chỉ build) |
| E2E với Platform thật | BLOCKED (Platform chưa hiện thực contract, nay có thêm yêu cầu gia hạn) |
| Bộ cài, máy sạch, Zalo thật | NOT RUN (ngoài phạm vi) |

## Rủi ro còn lại

1. Platform bắt buộc phải hiện thực **gia hạn bằng revision mới**. Nếu thiếu, mọi PC sẽ dừng gửi sau `60 phút + offlineGraceHours` kể từ cấu hình cuối (đúng thiết kế đóng an toàn, nhưng phải có trước khi phát hành).
2. PC so các mốc với **đồng hồ máy**. Người có quyền quản trị máy mà chỉnh đồng hồ lùi thì có thể gửi quá các mốc theo giờ thật. Chống chỉnh đồng hồ (ví dụ ghi nhận giờ lớn nhất đã thấy) là việc riêng, **chưa làm** ở vòng này.
3. Cửa sổ 60 phút là hằng số contract v1; đổi thì hai phía phải cùng đổi.
