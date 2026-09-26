# Báo cáo: phục hồi kích hoạt PENDING và mã chi nhánh — VETCLINIC CRM PC (2026-09-26, Claude)

- **Trạng thái:** **Đã chạy kỹ thuật** (LOCAL). Chờ Codex review, chưa được anh Huy duyệt. **Không** tự kết luận sẵn sàng giao khách.
  **Chưa commit, chưa push, chưa build bộ cài, chưa ký/upload, không deploy, không migration production, không Zalo thật, không gửi tin thật.**
- **Retest với Platform thật: BLOCKED.** Runtime QA của counterpart đã được Codex dừng và xóa DB sau lượt E2E của họ. Muốn chạy lại phải dựng lại trong worktree Platform; em không tự làm (mục 6). Mọi test của vòng này dùng **Platform giả**; không gọi là E2E thật.

## 0. Trạng thái trước khi sửa

| Repo | Nhánh | HEAD | Mục chưa commit |
|---|---|---|---|
| CRM `D:\DuAn\crm-standalone\customer-care-gateway` | `feat/standalone-pc-edition` | `5581357` | 34 trước; 35 sau (+ migration 0016; tài liệu nằm trong thư mục `docs/standalone/` chưa track) |
| Platform `D:\ChatGPT\Xây phần mềm\b2b-crm-pc-control-plane` (chỉ đọc) | `feat/crm-pc-control-plane` | `3cae17a` | 27 (của Codex; không đụng) |

Đã đọc: `AGENTS.md`, `AI-SYNC.md`, `docs/qa/codex-crm-pc-recovery-and-scope-2026-09-26.md` và `docs/integrations/crm-pc-platform-contract.md` phía Platform.

## 1. Nguyên nhân

1. **UI:** nút ngắt ghép chỉ hiện khi ACTIVE. Máy PENDING (mất phản hồi, mã quá 10 phút) không có đường phục hồi trên giao diện; khách bị kẹt. API unpair đã nhận PENDING nhưng:
   - chỉ trả trạng thái chung, không tách "đã xóa trên máy" với "Platform đã nhả thiết bị";
   - không giữ khóa đồng thời với kích hoạt.
2. **Backend:** chưa phân biệt lần kích hoạt **có thể đã ghép** trên Platform với lần **chắc chắn chưa ghép**. Vì vậy:
   - nhập mã khác khi đang chờ có thể dùng lại danh tính cũ theo cách không an toàn;
   - mã hết hạn vẫn thử lại mãi với Platform.
3. **Hiển thị:** sau ngắt ghép/thu hồi, thẻ giấy phép cũ vẫn hiện "Được gửi tin đến … còn 72 giờ", dễ hiểu nhầm (em phát hiện khi kiểm bằng trình duyệt).
4. **Mã chi nhánh:** mã nội bộ không phải UUID (vd. `812`) chỉ bị chặn chung là `BRANCH_NOT_LICENSED`, chưa nói rõ là thiếu ánh xạ.

## 2. File đã sửa

| File | Thay đổi |
|---|---|
| `prisma/migrations/0016_platform_activation_recovery/migration.sql` (mới), `prisma/schema.prisma` | `activationError`, `activationMaybeBound` (thêm cột, forward-only); lần chờ cũ được coi là có thể đã ghép (phía an toàn) |
| `src/standalone/platform/platform-device.service.ts` | `activation.state` (NOT_BOUND / RETRY_SAME_CODE / RECOVERY_REQUIRED / IN_PROGRESS). Có thể đã ghép ⇒ chỉ cho thử lại đúng mã; mã hết hạn hoặc thiết bị bị thu hồi ⇒ `ACTIVATION_RECOVERY_REQUIRED`, không gọi Platform. Kiểm khóa trước mọi thao tác. `unpair` giữ khóa, gọi Platform có ký, trả `reset: { local, platform }` theo đúng câu Platform trả lời. Chỉ thiết bị ACTIVE mới trả giấy phép/thời hạn |
| `src/standalone/platform/license-gate.service.ts`, `src/standalone/source-connector.service.ts` | `branchIdMatchesNamespace`: PETCLINIC/B2B_SALE bắt buộc UUID Platform ⇒ nếu không thì `BRANCH_MAPPING_REQUIRED` (gate, tạo tin, lưu kết nối, xem trước lịch/công nợ) |
| `web/src/pages/PlatformConnection.tsx`, `web/src/lib/{api,types}.ts` | Banner theo trạng thái chờ; form "Thử lại (nhập lại đúng mã cũ)"; mục "Phục hồi kích hoạt" 3 bước (tách việc của quản trị Platform); hộp xác nhận gõ `NGAT GHEP NOI` (thay `window.prompt`), tự cuộn tới và focus; kết quả "Trên máy này" / "Trên Platform" riêng; nút bị khóa khi đang chạy; xóa ô mã sau phục hồi; ẩn thẻ giấy phép khi không ACTIVE; thông báo lỗi mới |
| `test/platform-device.integration.spec.ts` | Mã chi nhánh test đổi sang UUID; Platform giả thêm các luật mới (TTL gốc cả khi thử lại, không hồi sinh thiết bị thu hồi, một PC chính, unpair trả 403 khi đã thu hồi); 4 test mới (mục 4) |
| `docs/standalone/platform-device-contract-v1.md` | Mục 8 (PENDING và phục hồi), mục 9 (mã chi nhánh) |
| `docs/standalone/huong-dan-phuc-hoi-kich-hoat.md` (mới) | Hướng dẫn cho khách và vận hành |

Không đổi: cơ chế Client ID/Secret cục bộ; hợp đồng lease 5 phút/`offlineGraceHours`; bắt buộc kích hoạt; HOLD không xóa; luật tin trễ 12 giờ; phạm vi chi nhánh theo từng nguồn.

## 3. Luồng: khách tự làm và bước cần quản trị Platform

| Tình huống | Khách tự làm | Cần quản trị Platform |
|---|---|---|
| Mất phản hồi, mã còn trong 10 phút | Nhập lại đúng mã ⇒ xong, **cùng** thiết bị | Không |
| Mã sai hoặc bị từ chối rõ ràng | Nhập mã khác | Cấp mã đúng |
| Mã quá 10 phút / thiết bị bị thu hồi | Bước 2: xóa trạng thái ghép nối có xác nhận; bước 3: nhập mã mới | Bước 1: thu hồi thiết bị treo; bước 3: tạo mã mới |
| Xóa trạng thái khi mất mạng | Làm được (A) | Kết quả B là "CHƯA xác nhận" ⇒ quản trị kiểm và thu hồi nếu còn |

## 4. Kiểm thử

### 4.1 Tự động (em tự chạy sau lần sửa cuối; Platform **giả**; DB QA `127.0.0.1:55499`, kiểm tên DB trước mỗi lệnh có TRUNCATE)

| Test | Nội dung | Kết quả |
|---|---|---|
| recovery 1 | Mất phản hồi ⇒ PENDING `RETRY_SAME_CODE`, không cấp giấy phép, tạo job bị chặn. Mã khác bị từ chối cục bộ, không gọi Platform. Nhân viên bị 403 cả kích hoạt lẫn phục hồi. Xác nhận sai/trống ⇒ không đổi. Lỗi mạng khi thử lại ⇒ giữ nguyên binding, không tự xóa, không báo thu hồi. Thử lại và phục hồi đồng thời ⇒ phục hồi bị `409 ACTIVATION_IN_PROGRESS`. Thử lại trong 10 phút ⇒ ACTIVE với **cùng** deviceId/khóa/requestId, 1 thiết bị trên Platform | PASS |
| branch namespace | `812` / `KHO-HCM` ⇒ `BRANCH_MAPPING_REQUIRED` ở gate, API tạo job, lưu kết nối, xem trước lịch; EXTERNAL ⇒ `SOURCE_NOT_LICENSED` | PASS |
| recovery 2 | Ngắt ghép bình thường ⇒ Platform xác nhận. Lần mới mất phản hồi ⇒ thiết bị treo trên Platform. Mã hết hạn ⇒ `RECOVERY_REQUIRED`; thử lại tiếp **không** gọi Platform. Platform không cho tạo mã khi còn PC treo. Quản trị thu hồi ⇒ phục hồi có xác nhận ⇒ `{local: UNPAIRED, platform: PLATFORM_ALREADY_REVOKED}`; kích hoạt đồng thời bị 409. Khóa API, nguồn, job, mẫu tin, Zalo, người dùng **không đổi** (so snapshot). Chưa kích hoạt lại ⇒ tạo job bị chặn, job đang chờ bị giữ, Sender **không** được gọi. Mã mới ⇒ deviceId/khóa **mới**, hồ sơ cũ vẫn REVOKED; tạo job lại được | PASS |
| recovery 3 | Mất mạng khi phục hồi ⇒ `PLATFORM_NOT_CONFIRMED` (không báo sai); lần kích hoạt chưa tới Platform ⇒ `PLATFORM_DEVICE_UNKNOWN`; mã còn hạn kích hoạt được danh tính mới | PASS |

| Lệnh | Kết quả |
|---|---|
| `npm test` (unit) | PASS 45/45 |
| `npm run test:platform` (Platform giả) | PASS 23/23 (19 cũ + 4 mới) |
| `npm run test:standalone` | PASS 18/18 |
| `npm run test:integration` (bản VPS) | PASS 117/117 |
| Build backend / build web | PASS / PASS |
| `prisma validate` | PASS |
| Migration 0016: DB sạch và DB nâng cấp; chạy lần hai "No pending"; deploy lên các DB QA cũ | PASS |
| Backfill 0016: DB tạm ở mức 0015 có bản ghi PENDING ⇒ sau nâng cấp `activationMaybeBound = true`; chạy lần hai "No pending"; DB tạm đã xóa | PASS |
| `git diff --check` | PASS |

### 4.2 Trình duyệt thật (in-app browser; CRM `dist` thật trên 127.0.0.1:47101, DB QA `ccg_platform_ui`; Platform **giả** 127.0.0.1:47198; không đụng bản anh Huy đang cài ở 47100)

| Trạng thái | Kết quả kiểm tra | Kết quả |
|---|---|---|
| Chưa kích hoạt | Banner "Chưa kích hoạt — chưa gửi được tin" và form mã | PASS |
| PENDING do mất phản hồi | Banner "Kích hoạt chưa hoàn tất (không nhận được phản hồi từ Platform)", form "Thử lại (nhập lại đúng mã cũ)", mục phục hồi hiện mã thiết bị | PASS |
| Lỗi mạng khi thử lại | Thông báo "Không kết nối được Platform…", vẫn PENDING | PASS |
| Thử lại thành công | ACTIVE, **cùng** mã thiết bị `a8a1…44b8` | PASS |
| Hủy xác nhận | Hộp đóng, API vẫn ACTIVE | PASS |
| Ngắt ghép có xác nhận | "Trên máy này: đã xóa" + "Trên Platform: đã xác nhận ngắt ghép" | PASS |
| Mã hết hạn | "Mã cũ không dùng được nữa", không còn form thử lại, hướng dẫn 3 bước với mã thiết bị `fb50…679a` trùng hồ sơ treo | PASS |
| Phục hồi | Platform giả từ chối tạo mã khi còn PC treo ⇒ thu hồi ⇒ xóa có xác nhận ⇒ "Trên Platform: hồ sơ thiết bị cũ đã được thu hồi" | PASS |
| Kích hoạt lại | Mã mới ⇒ ACTIVE, mã thiết bị **mới** `bf35…cfdc` | PASS |
| Mã sai | Trình duyệt tự điền lại mã cũ vào ô (nên mã bị dính) ⇒ "mã không đúng, có thể nhập mã khác", không kẹt | PASS (ghi chú ở mục 7) |
| Sai quyền (nhân viên) | Không có nút kích hoạt/phục hồi; gọi API trong phiên nhân viên ⇒ 403 cả hai, thiết bị vẫn ACTIVE | PASS |
| Màn hẹp 375 và 414 px | Không tràn ngang (`scrollWidth = viewport`), nút rộng hết khung, hộp xác nhận tự cuộn tới và focus ô nhập | PASS |
| Desktop 800 px (khung trình duyệt) | Ảnh các trạng thái trên | PASS |

Ảnh chụp nằm trong phiên làm việc (khung trình duyệt). Công cụ chụp đôi khi ra ảnh lặp 2×2 khi giả lập điện thoại; khi đó em kiểm thêm bằng số đo DOM và văn bản trang.

## 5. Ghi chú bảo mật và dữ liệu

- Mã kích hoạt không lưu dạng rõ (test kiểm bản ghi không chứa mã).
- Mã QA chỉ là mã giả do Platform giả sinh.
- Không in URL có mật khẩu, không đọc `.env` hay secret thật.

## 6. Retest với Platform thật — BLOCKED

Báo cáo của Codex cho biết HTTP E2E hai backend thật **PASS 18/18**, kể cả luồng phục hồi mã quá hạn **qua API**. Đó là kết quả của Codex trên bản CRM **trước** vòng này, không phải kết quả của vòng này.

Để chạy lại với bản CRM mới (có migration 0016, luật thử lại mới, mã chi nhánh bắt buộc UUID), cần task B2B chạy lại harness `scripts/qa/crm-pc-http-e2e.cjs`:
- dựng DB QA riêng trên container của họ;
- đối chiếu lại fingerprint CRM (mã nguồn đã đổi so với 71 file họ đã đối chiếu);
- thêm ca: PENDING + mã khác ⇒ 409; mã hết hạn ⇒ không gọi lại; `unpair` trả `reset.platform`.

Em không sửa worktree Platform và không dùng DB của họ.

## 7. Còn thiếu trước khi phát hành

1. Retest HTTP với counterpart Platform thật trên bản CRM này (BLOCKED, mục 6).
2. E2E với cầu nguồn PETCLINIC/B2B thật (Source Connector + HMAC), Sender/Zalo thật: NOT RUN.
3. Bộ cài Windows mới (migration 0016) trên máy sạch: NOT RUN.
4. ~~Trình duyệt tự điền lại mã cũ~~ — **đã xác minh lại và sửa** (mục 8): nguyên nhân là state React, không phải trình duyệt.
5. Quản trị Platform nên hiển thị mã thiết bị cùng dạng rút gọn `xxxx…yyyy` như PC để đối chiếu khi thu hồi (handoff cho task B2B, không bắt buộc).

## 8. Bổ sung 2026-09-26 — ô mã kích hoạt "tự điền lại mã cũ"

**Nguyên nhân (xác minh bằng trình duyệt thật, bản thử 47101, DB QA `ccg_platform_ui`, Platform giả):**
- **Tải lại trang thật** (`performance navigation type = reload`): ô **trống**. Không có mã trong localStorage, sessionStorage, cookie hay URL.
- **Rời trang rồi Back / Forward:** ô **trống** (component bị gỡ và dựng lại).
- **"Điều hướng" tới chính địa chỉ đang mở** (`#/ket-noi-platform`): đây **không** phải tải lại. Cùng một document (biến đánh dấu trên `window` vẫn còn), component vẫn gắn, nên mã gõ trước đó vẫn nằm trong **state React**. Lần QA trước em đã hiểu nhầm thao tác này là "tải lại".
- Thêm vào đó, sau khi Platform báo mã hết hạn hoặc từ chối, code cũ **không xóa** state mã (chỉ ẩn ô), nên khi ô hiện lại vẫn còn mã cũ.
- **Kết luận:** do state frontend. Không phải cơ chế khôi phục form của trình duyệt, không phải autofill, không phải dữ liệu ứng dụng lưu. Trong môi trường thử không có trình quản lý mật khẩu nào can thiệp.

**Sửa (chỉ frontend):**
- `web/src/lib/activation-code.ts` (mới, module thuần): chuẩn hóa khi gõ/dán; `shouldClearCodeAfterError` (hết hạn, cần phục hồi, thiết bị bị thu hồi, mã sai/đã dùng/sai sản phẩm/gói chưa hiệu lực ⇒ xóa; mất phản hồi/lỗi mạng ⇒ giữ để thử lại đúng mã); `shouldClearCodeForState` (ACTIVE, UNPAIRED, REVOKED, RECOVERY_REQUIRED ⇒ xóa); `activationInputProps` (thuộc tính hạn chế tự điền).
- `web/src/pages/PlatformConnection.tsx`: xóa mã khi thành công, khi phục hồi/ngắt ghép, khi lỗi làm mã vô dụng và khi trạng thái máy chủ làm mã vô dụng. Form và ô có `autocomplete="off"`, `name` ngẫu nhiên mỗi lần mở trang, `data-1p-ignore` / `data-lpignore` / `data-bwignore`. Chỉ bấm Kích hoạt/Enter mới gọi API; `onChange` chỉ cập nhật state. Không có bộ hẹn giờ xóa nội dung.
- Không đổi backend, TTL 10 phút, lease, quyền, Client ID/Secret hay điều kiện tạo/gửi tin.

**Kiểm thử:**

| Kiểm tra | Kết quả |
|---|---|
| `test/web-activation-code.spec.ts` (mới, 5 test): chuẩn hóa gõ/dán; khi nào xóa và khi nào giữ; thuộc tính chống tự điền; trang không dùng storage/URL; chỉ submit mới gọi `platformActivate` | PASS 5/5 |
| `npm test` (unit) | PASS 50/50 |
| `npm run test:platform` (Platform giả; binding PENDING, retry, phục hồi) | PASS 23/23 |
| Build web / build backend | PASS / PASS |
| `git diff --check` | PASS |
| Trình duyệt: gõ mã ⇒ tải lại thật ⇒ ô trống | PASS |
| Trình duyệt: rời trang ⇒ Back; Forward ⇒ Back ⇒ ô trống | PASS |
| Trình duyệt: mô phỏng tự điền (gán giá trị + sự kiện `input`/`change`) ⇒ **0** lệnh gọi `/platform/activate` | PASS |
| Trình duyệt: chèn văn bản kiểu dán (`insertText`) ⇒ chuẩn hóa `XY12-AB34-CD56`, không gọi API | PASS |
| Trình duyệt: dán thật bằng Ctrl+V | NOT RUN (clipboard trong khung trình duyệt nhúng không hoạt động: Ctrl+X/Ctrl+V không tác dụng) |
| Trình duyệt: mất phản hồi ⇒ mã giữ trên trang ⇒ xóa ô + tải lại ⇒ ô trống; binding trong DB (status, deviceId, requestId, khóa, maybeBound) **không đổi**; nhập lại đúng mã ⇒ ACTIVE **cùng** thiết bị `9dc5…59df` | PASS |
| Trình duyệt: mã hết hạn ⇒ `RECOVERY_REQUIRED`, state `code` trong component = `""` (đọc qua React fiber) | PASS |
| Trình duyệt: ngắt ghép/phục hồi ⇒ ô trống; mở lại màn hình ⇒ ô trống | PASS |
| Trình duyệt: gõ chữ thường + bấm nút Kích hoạt ⇒ ACTIVE thiết bị mới `2873…1b78` | PASS |
| Mã không xuất hiện trong DB (AuditLog, PlatformDeviceRegistration) và log máy chủ | PASS |
| `test:standalone`, `test:integration` (VPS) | NOT RUN lượt này (backend không đổi; lượt trước PASS 18/18 và 117/117) |

**Giới hạn:** các thuộc tính trên chỉ là **gợi ý** cho trình duyệt và trình quản lý mật khẩu. Một số trình quản lý mật khẩu (hoặc người dùng chủ động chọn gợi ý) vẫn có thể điền vào ô. Em **không** tuyên bố chặn được tự điền tuyệt đối; chưa thử với 1Password, Bitwarden, LastPass hay trình quản lý của Edge/Chrome có dữ liệu thật. Nếu có tự điền, ứng dụng vẫn **không** tự gửi. Mã chỉ được gửi khi người dùng bấm Kích hoạt, và Platform từ chối rõ ràng nếu mã sai.

## 9. Bổ sung 2026-09-26 — kích hoạt an toàn khi CRM bị tắt đột ngột (Codex review)

**Trạng thái:** Đã chạy kỹ thuật (LOCAL, Platform **giả lập**). Chờ Codex review. **E2E với Platform thật cho bản này: chưa chạy** (task B2B chạy lại với fingerprint bên dưới). Kết quả HTTP 18/18 trước đó là của bản **trước** khi sửa, không dùng thay.

**Nguyên nhân (Codex tái hiện):** `claim()` tạo lần kích hoạt PENDING với `activationMaybeBound=false`; cờ chỉ được bật trong `catch` sau lỗi. Nếu Platform đã đăng ký thiết bị nhưng CRM bị kill hoặc mất điện trước khi lưu kết quả hay chạy `catch`, DB giữ `false`. Khi mở lại máy và khóa 2 phút hết hạn, nhập mã **khác** sẽ ghi đè `pendingRequestId`/`pendingCodeHash`, làm mất thông tin để thử lại lần cũ.

**Cách sửa (`src/standalone/platform/platform-device.service.ts`):**
- `claim()` ghi bền vững **trước** khi yêu cầu rời máy: deviceId/khóa, `pendingRequestId`, `pendingCodeHash` và `activationMaybeBound=true`, cho cả lần đầu và lần thử lại.
- Cờ chỉ được hạ khi có bằng chứng lần đó **chưa đăng ký**: Platform từ chối rõ ràng (HTTP 4xx thuộc nhóm từ chối trước khi ghép: mã sai, mã hết hạn, mã đã dùng ở máy khác, sai sản phẩm/doanh nghiệp, gói chưa hiệu lực, proof sai) cho **lần gửi đầu tiên** của requestId đó. Khi đó xóa luôn `pendingRequestId`/`pendingCodeHash`.
- Từ chối ở **lần thử lại** không chứng minh gì về lần trước (mã hết hạn có thể thuộc thiết bị đã tạo), nên giữ binding và đi luồng phục hồi.
- Timeout, mất mạng, lỗi 5xx, phản hồi không áp dụng được, lỗi ghi DB cục bộ hay crash: giữ binding.
- **PENDING do phiên bản cũ để lại:** `maybeBound(reg) = activationMaybeBound || pendingRequestId != null`. Bản ghi `false` nhưng còn request đang treo vẫn bị coi là "có thể đã đăng ký". Không cần migration mới (0016 đã backfill bản ghi PENDING có request).
- **Chống phản hồi muộn ghi đè:** mọi lần ghi sau `claim()` (ACTIVE khi thành công, ghi lỗi, nhả khóa) đều có điều kiện khớp `status=PENDING` + `deviceId` + `pendingRequestId` + **token khóa** (`activationLockedUntil` chính xác của lần đó). Phục hồi cũng chỉ ghi `UNPAIRED` khi còn giữ đúng token của nó, nếu không thì trả `409`. Kết quả muộn của lần cũ vì vậy không ghi đè lần thử lại hay lần phục hồi mới.
- Không đổi: TTL 10 phút (phía Platform), lease 5 phút/`offlineGraceHours`, quyền chi nhánh, điều kiện gửi, Client ID/Secret cục bộ, dữ liệu khách/nguồn/mẫu tin/lịch sử/tin đang chờ. Không tự tạo thiết bị mới, không thu hồi, không reset vì lỗi mạng.

**File thay đổi vòng này:**
- `src/standalone/platform/platform-device.service.ts`
- `test/platform-device.integration.spec.ts` (4 test crash-logic; Platform giả thêm `redeemPlan` cho từng lần gọi)
- `scripts/qa/crm-pc-crash-recovery.cjs` (mới, harness kill tiến trình thật)
- `scripts/qa/crm-pc-fingerprint.cjs` (mới, fingerprint tái lập được)
- Tài liệu này, `huong-dan-phuc-hoi-kich-hoat.md`

**Kiểm thử (em tự chạy trên mã nguồn cuối; DB QA `127.0.0.1:55499`, kiểm tên DB trước mỗi lệnh có migration/TRUNCATE; không đụng cổng 47100):**

| Lệnh / test | Kết quả |
|---|---|
| `npm test` (unit, 13 suite) | PASS 50/50 |
| `npm run test:platform` (Platform giả; gồm crash 1–4: dấu "có thể đã đăng ký" có trước khi gửi; bản ghi crash chặn mã khác mà không gọi Platform; đúng mã giữ binding; bản ghi phiên bản cũ; từ chối lần đầu và từ chối khi thử lại; mã hết hạn sau kết quả không rõ; phản hồi thành công muộn sau khi phục hồi ⇒ vẫn UNPAIRED; phản hồi lỗi muộn sau khi thử lại thành công ⇒ vẫn ACTIVE) | PASS 27/27 |
| Thử đột biến: đưa code về hành vi cũ (cờ false khi claim, bỏ luật request đang treo) | 8 test FAIL, đúng mong đợi; code đã khôi phục (giống hệt bản sao lưu trước thử, không còn dấu đột biến) |
| `npm run test:standalone` (bản PC) | PASS 18/18 |
| `npm run test:integration` (hồi quy bản VPS) | PASS 117/117 |
| Build backend / build web | PASS / PASS |
| `prisma validate`; migrate deploy các DB QA: không còn pending | PASS |
| `git diff --check` | PASS |
| **Crash bằng tiến trình thật** `node scripts/qa/crm-pc-crash-recovery.cjs` — Platform **GIẢ LẬP** trong harness, CRM chạy `node dist/main.js` là tiến trình con (cổng 47102), DB QA mới `ccg_crash_qa` (tạo, migrate 2 lần, xóa sau khi chạy) | **PASS 24/24** |

Bằng chứng test crash (lượt cuối, sau build cuối):
- **Kịch bản 1:** Platform giả ghi nhận redeem (thiết bị đã đăng ký) rồi giữ phản hồi. Harness kill đúng PID 11988 (thoát code 1). DB còn PENDING, "có thể đã đăng ký", request/binding đã lưu. Khởi động lại (PID 16928), cùng DB và cùng khóa QA:
  - khi khóa cũ còn hiệu lực: mã khác ⇒ `409 ACTIVATION_IN_PROGRESS`;
  - sau khi khóa hết hạn (chờ thật 120 giây): trạng thái "thử lại đúng mã"; mã khác ⇒ `409 ACTIVATION_RETRY_SAME_CODE`, **không** gọi Platform, binding (requestId, deviceId, khóa) không đổi;
  - đúng mã ⇒ ACTIVE cùng deviceId/khóa, Platform chỉ có 1 thiết bị, mọi redeem của mã dùng cùng requestId.
- **Kịch bản 2:** ngắt ghép có xác nhận (Platform xác nhận). Lần kích hoạt mới bị kill sau khi đã đăng ký; khởi động lại; mã hết hạn phía Platform; chờ khóa hết hạn:
  - `403 ACTIVATION_CODE_EXPIRED` và binding **không** bị nhả;
  - thử tiếp: cùng mã ⇒ `ACTIVATION_RECOVERY_REQUIRED`, mã khác ⇒ `ACTIVATION_RETRY_SAME_CODE`, không gọi Platform;
  - Platform từ chối tạo mã mới khi còn thiết bị treo; quản trị thu hồi;
  - xác nhận sai ⇒ không đổi; phục hồi có xác nhận ⇒ `{local: UNPAIRED, platform: PLATFORM_ALREADY_REVOKED}`;
  - chưa kích hoạt lại ⇒ tạo job bị từ chối `PLATFORM_UNPAIRED` (khóa API cục bộ vẫn hợp lệ);
  - mã mới ⇒ ACTIVE với deviceId/khóa **mới**, thiết bị cũ vẫn REVOKED; tạo job lại được.
- Log CRM không chứa mã kích hoạt. Harness không in mã, khóa riêng hay secret.
- Harness chỉ kill theo PID của tiến trình con nó tạo (`process.kill(pid)`), không kill theo tên. Cảnh báo `DEP0190` của Node ở lượt đầu đã được bỏ bằng cách gọi thẳng `node node_modules/prisma/build/index.js` (không dùng shell/npx); lượt cuối không còn cảnh báo.

**Fingerprint bản cuối (cho task B2B chạy lại E2E với Platform thật):** `node scripts/qa/crm-pc-fingerprint.cjs --verify-build` (repo CRM, HEAD `5581357` + thay đổi chưa commit).

| Tập | Phạm vi | Số file | SHA-256 |
|---|---|---|---|
| source | `src/**/*.ts`, `prisma/schema.prisma`, `prisma/migrations/**/*.sql`, `web/src/**/*.{ts,tsx,css}`, `package.json`, `package-lock.json` (CRLF→LF) | 116 | `2be4f2ed0b7a2d2bc1b871fc3fc5bab6b18bcc347f5f34a33ff406ab21e50656` |
| backend source | `src/**/*.ts` (CRLF→LF) | 71 | `aa5a42afd3fe9d26d8b22317f512f20b5258b7df9c47c160c1776bdaab810a45` |
| dist backend | `dist/**/*.js` (byte thô) | 71 | `fcb09eef7328d9b2593351047ca1d2a903963eac28a18a0c6fb057f383c1e935` |
| dist web | `public/**` (byte thô, build Vite) | 34 | `5a12148fe4ffe77a0005446b2e890c21ed33b86f3190254e7de084464dd42b67` |

- **Cách tính:** mỗi tập = sha256 của các dòng `"<sha256(file)>  <đường/dẫn/tương/đối>\n"`, sắp theo đường dẫn.
- **`--verify-build`:** biên dịch lại `src` bằng tsconfig của repo trong bộ nhớ (không ghi file) và so từng file JS với `dist/` ⇒ **71/71 giống hệt, 0 lỗi TypeScript**. Nghĩa là dist khớp mã nguồn hiện tại.
- **Build web:** chạy `npm run build` trong `web/` sau lần sửa web cuối; không so từng byte (bundle Vite).
- **Contract:** không đổi wire contract với Platform ở vòng này. Chỉ đổi cách PC lưu và giữ binding; contract mục 8 vẫn đúng.

**Chưa kiểm thử / còn thiếu:**
- E2E HTTP với Platform thật trên bản này, gồm kill tiến trình khi Platform thật đang trả redeem: **NOT RUN**, chờ task B2B.
- Mất điện thật / tắt Windows (khác với kill tiến trình): **NOT RUN**.
- Bộ cài trên máy sạch, nguồn PETCLINIC/B2B thật, Sender/Zalo thật: **NOT RUN**.
- Giao diện không đổi ở vòng này, nên không kiểm lại bằng trình duyệt.

