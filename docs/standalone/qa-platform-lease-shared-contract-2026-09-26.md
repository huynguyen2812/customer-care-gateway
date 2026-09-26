# Báo cáo: thời hạn giấy phép khớp contract chung CRM PC ↔ Platform (2026-09-26, Claude)

- **Trạng thái:** **Đã chạy kỹ thuật** với Platform **GIẢ LẬP** mô phỏng đúng quy tắc của counterpart Platform local. Chờ Codex review, chưa được anh Huy duyệt.
  **E2E HTTP với counterpart Platform thật: NOT RUN** (lý do ở mục 5). Test giả PASS **không** có nghĩa E2E Platform thật PASS.
  **Chưa commit, chưa push, chưa build bộ cài, chưa upload, không deploy, không sửa VPS/DNS, không migration production, không Zalo thật.**
- **Thay thế** phần "cửa sổ gia hạn trực tuyến 60 phút / Platform gia hạn mỗi 30 phút / ~48 cấu hình mỗi ngày" trong
  `qa-platform-license-expiry-fix-2026-09-26.md`. Quy tắc đó **chưa được duyệt**, khác contract chung, và đã bị bỏ khỏi code và contract CRM.
  Không yêu cầu Platform đổi theo quy tắc đó.

## 0. Trạng thái trước khi sửa

| Repo | Nhánh | HEAD | Mục chưa commit |
|---|---|---|---|
| CRM `D:\DuAn\crm-standalone\customer-care-gateway` | `feat/standalone-pc-edition` | `5581357` | 34 (các vòng trước; giữ nguyên) |
| Platform `D:\ChatGPT\Xây phần mềm\b2b-crm-pc-control-plane` (chỉ đọc) | `feat/crm-pc-control-plane` | `3cae17a` | 22 (của Codex; sau vòng này vẫn 22, không đụng) |

Không reset/restore/stash/clean. Không sửa repo Platform, Sender hay CRM VPS. Không có migration mới ở vòng này.

## 1. Đối chiếu contract chung và code Platform (đọc `crm-pc-platform-contract.md`, `crm-pc-device.service.ts`, `crm-pc-device.controller.ts`, `dto/crm-pc-device.dto.ts`)

| Điểm | Platform (code thực tế) | CRM trước vòng này | CRM sau |
|---|---|---|---|
| Lease | `expiresAt = min(now + max(5 phút, grace h), hạn CRM/nguồn còn hiệu lực)` | Tự cộng thêm cửa sổ 60 phút + grace sau mốc gốc | Chỉ thực thi `expiresAt` và `plan.validUntil` đã ký; kiểm lease không dài quá công thức |
| Gia hạn | Revision mới khi `expiresAt − now ≤ min(24 h, lease/3)` của envelope đang lưu và hạn mới muộn hơn | Đòi Platform gia hạn mỗi 30 phút | PC chỉ sync theo lịch; Platform quyết định |
| Lịch sync | Contract: tối đa 2 phút | 15 phút | Mặc định 60 giây, kẹp 15–120 giây; lần đầu sau 10 giây |
| Replay | Cùng revision ⇒ cùng envelope đã lưu | DUPLICATE, không gia hạn | Giữ nguyên |
| Denial | Revision mới, `plan.status` EXPIRED/SUSPENDED, `expiresAt` tương lai, `plan.validUntil` có thể đã qua | Chấp nhận | Chấp nhận (có test) |
| Thu hồi | `403 {code: DEVICE_REVOKED}`; thiết bị lạ ⇒ `401 DEVICE_UNKNOWN` | Coi cả `DEVICE_UNKNOWN` là thu hồi | Chỉ đúng `403` + `DEVICE_REVOKED` (hoặc `deviceStatus`/cấu hình ký REVOKED) |
| `offlineGraceHours` | Số nguyên 0–72 (Platform tự kiểm) | Số nguyên 0–72, bắt buộc | Giữ nguyên |
| Chữ ký request, nonce, path `/api/crm-pc/v1/...`, heartbeat DTO, `buildCommit` (SHA 40 ký tự hex), UUID v4, `appVersion` | Như contract | Khớp (đối chiếu tĩnh) | Không đổi |

### Phần phía Platform còn thiếu / cần xác nhận (đối chiếu code, chưa E2E)

1. **Redeem lặp lại sau mất ACK có thể trả cấu hình đã hết hạn.** `redeem()` khi mã đã dùng trả nguyên `redeemResponse` lưu lúc đầu. Với `offlineGraceHours = 0`, cấu hình trong đó hết hạn sau 5 phút.
   - Hậu quả: PC thử lại sau 5 phút sẽ từ chối `CONFIG_EXPIRED`, không kích hoạt được, và mã đã bị dùng ⇒ phải xin mã mới.
   - Đề xuất cho Platform: khi phát lại redeem cho đúng binding, trả envelope **hiện tại** của thiết bị (`signedConfigEnvelope`) thay vì envelope lúc redeem. Chỉ cần thay đổi trong `crm-pc-device.service.ts`; em **không** tự sửa repo Platform.
2. **Mã chi nhánh:** Platform cấp `allowedBranchIds` là UUID chi nhánh trên Platform. Source Connector đọc `branchId` từ hệ thống nguồn (PETCLINIC/B2B). Hai bên phải dùng **cùng mã** chi nhánh, nếu không mọi lịch sẽ bị `BRANCH_NOT_LICENSED`. Cần xác nhận trong E2E.
3. Migration `20260926010000_crm_pc_signed_config_lease` của Platform chưa chạy trên DB QA nào và API chưa khởi động qua HTTP (theo `docs/qa/codex-crm-pc-control-plane-2026-09-26.md`). Vì vậy chưa có counterpart HTTP sẵn sàng để E2E.

## 2. Thay đổi phía CRM (vòng này)

| File | Thay đổi |
|---|---|
| `src/standalone/platform/platform-device.contract.ts` | Bỏ `ONLINE_RENEWAL_WINDOW_MINUTES`; thêm `MIN_ONLINE_LEASE_MS` (5 phút) và `PLATFORM_SYNC_MAX_INTERVAL_MS` (2 phút) kèm mô tả công thức chung |
| `src/standalone/platform/platform-crypto.ts` | `verifyConfig`: lease phải `0 < expiresAt − issuedAt ≤ max(5 phút, grace h)` (+1 giây) ⇒ nếu không thì `CONFIG_LEASE_INVALID`; `plan.validUntil` phải là ISO hoặc null. Denial có `plan.validUntil` quá khứ vẫn hợp lệ |
| `src/standalone/platform/license-gate.service.ts` | `licenceWindow` = min(`expiresAt` ký, `plan.validUntil` ký); bỏ mốc offline tự tính và mã `PLATFORM_OFFLINE_GRACE_EXPIRED`; `plan.validUntil` không đọc được ⇒ đóng an toàn |
| `src/standalone/platform/platform-device.service.ts` | Thu hồi chỉ khi `403` + `DEVICE_REVOKED`; `status()` trả `licensedUntil`/`configExpiresAt` từ cấu hình ký. Vẫn giữ: sync 200/replay/cấu hình lỗi không gia hạn, chỉ revision mới hợp lệ mới cập nhật thời hạn (nguyên tử trong `applyConfigTx`) |
| `src/standalone/platform/platform-sync.runtime.ts` | `syncIntervalMs()`: mặc định 60 giây, kẹp 15–120 giây (`PLATFORM_SYNC_INTERVAL_SECONDS`); lần đầu sau 10 giây |
| `src/standalone/local-status.controller.ts` | `licensedUntil`, `configExpiresAt` |
| `web/src/pages/PlatformConnection.tsx` | Bỏ thông báo "offline grace", sửa thông báo `PLATFORM_CONFIG_EXPIRED` |
| `test/platform-config.spec.ts`, `test/platform-device.integration.spec.ts` | Test mới (mục 3); Platform giả mô phỏng quy tắc lease/gia hạn của `crm-pc-device.service.ts` |
| `docs/standalone/platform-device-contract-v1.md` | Trạng thái, mục 3.2 (sync ≤ 2 phút, quy tắc thu hồi), mục 4 (kiểm lease), mục 4.1 viết lại theo contract chung, mục 5, mục 7 |

Không đổi: cơ chế Client ID/Secret cục bộ, kích hoạt nguyên tử, phạm vi theo nguồn, bắt buộc kích hoạt, HOLD không xóa, luật tin trễ 12 giờ.

## 3. Test (em tự chạy trong vòng này)

Chỉ giả `Date` bằng jest modern timers; mọi hàm hẹn giờ vẫn chạy thật. Các test có worker chạy thời gian thật và dời `expiresAt`/`plan.validUntil` của cấu hình mới nhất trong DB QA. Trước mỗi lệnh có TRUNCATE đều kiểm `DATABASE_URL` = `127.0.0.1:55499` + đúng tên DB QA (`ccg_platform_it` / `ccg_standalone_it` / `ccg_standalone_qa`); không in URL có mật khẩu.

| Yêu cầu | Test | Kết quả |
|---|---|---|
| grace 0 tại t0 ⇒ `expiresAt = t0 + 5 phút` | vector (đồng hồ giả) | PASS |
| t0 + 2 phút sync không có cấu hình mới ⇒ không kéo dài | vector: toàn bộ trạng thái giấy phép không đổi | PASS |
| t0 + 3 phút 20 giây: revision mới ⇒ thời hạn mới = (t0 + 3:20) + 5 phút, revision +1 | vector | PASS |
| Không nhận cấu hình mới: 1 ms trước hạn ⇒ cho; đúng hạn và 10 phút sau ⇒ `PLATFORM_CONFIG_EXPIRED` | vector (Platform không truy cập được) | PASS |
| Gói còn 90 giây ⇒ giấy phép = đúng 90 giây; đúng mốc ⇒ `PLAN_EXPIRED` | vector | PASS |
| Denial EXPIRED sau hạn gói (`plan.validUntil` = tE đã qua, envelope +5 phút) ⇒ áp dụng, HOLD, thiết bị vẫn ACTIVE | vector | PASS |
| Denial SUSPENDED/EXPIRED có `plan.validUntil` quá khứ ⇒ `APPLIED`, HOLD, tin được giữ | test gói | PASS |
| grace 72 ⇒ đúng issuedAt + 72 giờ, không có thêm 60 phút | vector + unit (lease 73 giờ bị từ chối) | PASS |
| Replay cùng revision ⇒ `DUPLICATE`, không gia hạn | vector + test worker | PASS |
| Cấu hình lỗi (sai chữ ký, lease quá dài, sai thiết bị, revision cũ, cùng revision khác nội dung) ⇒ không gia hạn | test worker | PASS |
| `403 DEVICE_REVOKED` ⇒ dừng gửi, không quay lại chế độ bỏ qua | test thu hồi | PASS |
| `401 DEVICE_UNKNOWN`, 403 mã khác, 403 không mã, 503, lỗi mạng ⇒ không thu hồi, không gia hạn | test mới | PASS |
| Worker không gọi Sender khi bị chặn (spy `ChannelRouterService.send`) | test worker, test hết hạn gói | PASS |
| Khi bị chặn vẫn xem/xoay/thu hồi Client ID/Secret, xem lịch sử, xem trước nguồn | test worker | PASS |
| Revision mới hợp lệ ⇒ tin đang giữ được gửi; tin trễ 13 giờ vẫn hủy `EXPIRED_WHILE_OFFLINE` | test worker | PASS |
| `offlineGraceHours` thiếu/null/chuỗi/âm/số lẻ/> 72 ⇒ từ chối | unit | PASS |
| Lịch sync mặc định 60 giây, không quá 2 phút | unit | PASS |
| Hồi quy: bắt buộc kích hoạt, cờ bypass, kích hoạt nguyên tử, mất ACK, phạm vi theo nguồn, heartbeat không PII, khôi phục/ngắt ghép | các test cũ trong cùng file | PASS |

| Lệnh | Kết quả |
|---|---|
| `npm test` (unit) | PASS 45/45 |
| `npm run test:platform` (Platform giả) | PASS 19/19 |
| `npm run test:standalone` | PASS 18/18 |
| `npm run test:integration` (bản VPS) | PASS 117/117 |
| Build backend / build web | PASS / PASS |
| `prisma validate` / `migrate status` (QA) | PASS / up to date |
| `git diff --check` | PASS |

## 4. Phần dùng giả lập

Platform giả trong `test/platform-device.integration.spec.ts` chạy lại đúng các quy tắc của counterpart Platform:
- `leaseSync()`: lease, cửa sổ gia hạn = min(24 h, lease/3) theo envelope đang lưu, chỉ gia hạn khi hạn mới muộn hơn, revision mới khi chính sách đổi hoặc đã hết hạn, denial khi gói hết hạn;
- phản hồi `403 DEVICE_REVOKED` / `401 DEVICE_UNKNOWN`.

Đây là mô phỏng do em viết theo code Platform, **không** phải chạy code Platform.

## 5. E2E HTTP với counterpart Platform thật — NOT RUN

**Lý do:**
- Counterpart chỉ có trong worktree của Codex, còn thay đổi chưa commit.
- Migration lease mới chưa chạy trên DB QA nào.
- API Platform chưa từng khởi động qua HTTP với cấu hình local; báo cáo của Codex cũng ghi "Device API E2E qua HTTP: NOT RUN".
- Muốn chạy thì phải `prisma generate`/build trong worktree đó, tức là ghi vào vùng Codex đang giữ. Em không làm.

**Đề xuất chạy khi Codex sẵn sàng**, tách DB để không dùng/xóa chung:
1. Codex dựng API Platform trên DB QA riêng (ví dụ `qa_crm_pc_e2e_platform`), chạy migrate deploy hai lần, seed 1 tenant + CRM + nguồn + chi nhánh, bật khóa ký cấu hình QA, rồi đưa em URL local, mã kích hoạt và khóa công khai (`keyId` + PEM).
2. Em chạy CRM trên DB riêng (`ccg_platform_e2e`, không TRUNCATE DB của Platform) với `PLATFORM_DEVICE_API_URL=http://127.0.0.1:<port>/api/crm-pc/v1` và `PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL=1`.
3. Kịch bản: redeem → sync lặp → gia hạn grace 0 (t0 + 3:20) → Platform tạm dừng/hết hạn ⇒ denial → thu hồi ⇒ 403 → unpair → mất ACK lúc redeem.
4. Nếu lệch, em báo đúng request/response/trường sai; không tự sửa repo Platform.

## 6. Rủi ro còn lại

1. Mục 1.1 (redeem lặp lại trả envelope đã hết hạn) cần phía Platform xử lý trước khi phát hành, nhất là với grace nhỏ.
2. Mã chi nhánh giữa Platform và hệ thống nguồn phải thống nhất (mục 1.2).
3. PC so mốc bằng đồng hồ máy; chỉnh đồng hồ lùi có thể gửi quá hạn theo giờ thật. Chưa có chống chỉnh đồng hồ.
4. Heartbeat mỗi 60 giây làm tăng số request lên Platform (1 request/phút/máy). Chấp nhận được theo contract "sync ≤ 2 phút"; có thể đặt 120 giây bằng `PLATFORM_SYNC_INTERVAL_SECONDS`.
