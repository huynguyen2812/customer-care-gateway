# QA: tách kênh cập nhật 0.2.x/0.3.x, preflight kiểm remote thật, thời điểm cấp mã kích hoạt (2026-09-26, Claude)

- **Trạng thái:** Đã chạy kỹ thuật (LOCAL) và Codex đã review; anh Huy đã cho phép chốt Git. Chưa phát hành cho khách.
  **Chưa commit/push, chưa build bản chính thức, chưa upload, chưa đăng manifest, không Zalo thật, không đụng production hay bản đang cài ở cổng 47100.**
  Không kết luận "sẵn sàng giao khách" (còn chờ Platform: mục 6).
- **Repo:**
  - CRM `D:\DuAn\crm-standalone\customer-care-gateway`, `feat/standalone-pc-edition` @ `7b699ac` = remote `origin` (đã kiểm bằng `git ls-remote`). Thay đổi của vòng này chưa commit.
  - Sender `feat/standalone-pc-edition` @ `0f091e11` = remote `vetclinic`.
  - Không sửa repo B2B/Platform.

## 1. Chặn nâng cấp không an toàn từ 0.2.x

**Đọc updater thật của bản cũ** (bản 0.2.1 đang cài, `C:\Program Files\VETCLINIC CRM\app\0.2.1-pc\scripts`, chỉ đọc):
- `check-update.ps1` lấy `settings.updateManifestUrl`. Nếu rỗng ⇒ `NOT_CONFIGURED`, không cập nhật.
  - Mặc định của 0.2.1 là rỗng.
  - Máy anh Huy: `settings.json` có `updateManifestUrl: ""`, trạng thái `update-check.json` = `NOT_CONFIGURED`, log "Chưa cấu hình địa chỉ cập nhật".
  - **Máy 0.2.1 này không tự cập nhật.**
- Mã nguồn trước vòng này (cũng là mã đã build ra 0.2.2-pc) mặc định đọc `https://vetclinic.vn/tai-ve/crm-pc/manifest.json`. **Bản 0.2.2 (nếu có máy cài) sẽ đọc địa chỉ đó.** Bộ cài 0.2.2 chưa từng được đăng lên web, và thư mục phát hành 0.2.x đã được anh Huy xóa.
- `tools/vcupdate.mjs verify` của 0.2.1 chỉ chấp nhận manifest có `product === "VETCLINIC CRM PC"`, ngược lại `MANIFEST_INVALID` và không cập nhật. Nó **không** đọc trường "phiên bản tối thiểu" hay cờ Platform nào.
- Tự cập nhật chạy `update.ps1` **cũ** ⇒ không tạo `DEVICE_KEY_ENC_KEY` ⇒ máy 0.3 không kích hoạt được.

**Cách sửa** (dựa trên đúng hành vi của updater cũ, không dựa vào trường mới mà updater cũ không đọc):

| Thành phần | Thay đổi |
|---|---|
| Kênh mới | `https://vetclinic.vn/tai-ve/crm-pc/v3/manifest.json` (gói, `.exe`, `SHA256SUMS` trong `/tai-ve/crm-pc/v3/`). Kênh cũ `…/crm-pc/manifest.json` dành riêng cho 0.2.x, **không bao giờ** đăng manifest 0.3+ vào đó. |
| `release.ps1` | Manifest ghi `product: "VETCLINIC CRM PC v3"`, `channel: "v3"` (bản thử: `"v3-qa"`). |
| `tools/vcupdate.mjs` (bản mới) | Chỉ chấp nhận `product "VETCLINIC CRM PC v3"` + `channel "v3"`. `v3-qa` chỉ được nhận khi máy QA đặt `VC_UPDATE_ALLOW_QA=1` (dịch vụ không bao giờ đặt). |
| `VetclinicCrm.psm1` | Mặc định kênh v3. `updateManifestUrl` rỗng **hoặc** bằng địa chỉ kênh cũ ⇒ dùng kênh v3; địa chỉ khác do quản trị đặt thì giữ. |
| Preflight | Từ chối BaseUrl khác `https://vetclinic.vn/tai-ve/crm-pc/v3` (kênh cũ bị từ chối với thông báo riêng). Từ chối bộ cài mặc định không đọc `…/v3/manifest.json`. |

**Kết quả:** updater 0.2.x **không thể** áp dụng manifest 0.3, kể cả khi lỡ đăng vào địa chỉ cũ. Máy 0.2.x lên 0.3 **chỉ bằng `.exe`**; sau đó máy tự đọc kênh v3.

## 2. Thời điểm cấp mã kích hoạt
- Bỏ yêu cầu "cấp mã cho khách trước khi đăng bản" (mục cũ trong `phat-hanh-0.3.0-pc.md` và `AI-SYNC.md`). Mã chỉ sống 10 phút.
- **Phát hành:** cấp mã cho từng khách khi khách đã cài xong và đang mở màn "Kết nối Platform".
- **QA production:** hẹn Platform tạo mã ngay trước lượt thử.
- Không đổi thời hạn mã, không đổi chống replay. Mã hết hạn ⇒ xin mã mới, hoặc phục hồi nếu lần trước có thể đã đăng ký.

## 3. Preflight kiểm remote thật
- Trước đây so `HEAD` với `@{u}` (ref tracking cục bộ, có thể cũ). Nay dùng `git ls-remote --exit-code <remote> refs/heads/<branch>`, không fetch/push/pull.
- **Remote được phép:** CRM `origin`, Sender `vetclinic` (không dùng `upstream-zalocrm`). Upstream phải đúng `<remote>/<branch>`.
- **FAIL rõ ràng khi:** còn thay đổi chưa commit; HEAD detached; không có upstream; upstream sai remote; remote không truy cập được hoặc không xác thực được; branch không có trên remote; HEAD khác commit trên remote.
- **Không prompt, không lộ URL:** `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, timeout 30 giây. Thông báo chỉ ghi **tên** remote, không in URL (test kiểm).

## 4. Đường bỏ qua preflight đã tìm thấy và đã chặn
1. **`-AllowDirty` trên mã nguồn sạch với số phiên bản chính thức.**
   - Trước: được phép, tức bỏ qua preflight mà vẫn ra `0.3.0-pc`.
   - Nay: `-AllowDirty` luôn đòi hậu tố `-dev`/`-qa`.
   - Chứng minh: chạy `release.ps1` thật trên bản clone **sạch** của hai repo (thư mục tạm, đã xóa) với `-Version 0.3.0-pc -AllowDirty` ⇒ dừng ngay với lỗi "-AllowDirty chỉ dùng cho bản thử", exit 1, **không** tạo thư mục build.
2. **`-SkipBuild` dùng lại stage cũ hoặc stage build từ mã chưa commit.**
   - Nay bản chính thức kiểm `BUILD-INFO.json` của stage: đúng phiên bản, `crmSourceDirty`/`senderSourceDirty` = false, commit CRM/Sender = HEAD hiện tại.
3. **`-AllowLocalUrl` đi cùng phiên bản chính thức.**
   - Review cuối phát hiện cờ QA này trước đây có thể làm preflight chấp nhận gói mang tên production nhưng trỏ tới máy thử.
   - Nay `release.ps1` chỉ cho phép cờ này khi đồng thời dùng `-AllowDirty` và phiên bản `-dev`/`-qa`; official preflight luôn từ chối cờ này và luôn yêu cầu HTTPS đúng kênh v3.
4. **Manifest của bản thử** (ký bằng cùng khóa) nếu lỡ đăng lên kênh v3 sẽ bị updater khách từ chối, vì `channel: "v3-qa"`.
5. **Ngoài phạm vi, chỉ ghi nhận:** chạy tay `build.ps1` + ISCC + tự ký manifest thì không đi qua `release.ps1`. Đây là thao tác thủ công có chủ ý, không phải đường phát hành. Quy trình phát hành bắt buộc dùng `release.ps1`.

## 5. Kiểm thử (em tự chạy trên mã nguồn cuối)

| Kiểm tra | Kết quả |
|---|---|
| `test/update-channel.spec.ts` (mới, 6 test; máy chủ HTTP giả lập 127.0.0.1, `VC_UPDATE_ALLOW_LOCAL=1`; khóa ký tạm, không phải khóa thật) | **PASS 6/6** |
| — bản mẫu `test/fixtures/legacy-0.2.1/vcupdate.mjs` giống hệt bản đang cài (SHA-256 `12b0aff9…11c6`) | PASS |
| — đối chứng: updater 0.2.1 thật **vẫn nhận** manifest kênh cũ (test không bị "đạt giả") | PASS |
| — updater 0.2.1 thật **từ chối** manifest 0.3 ở kênh v3 **và** khi lỡ đăng ở địa chỉ cũ (`MANIFEST_INVALID`) | PASS |
| — updater mới nhận v3; từ chối kênh cũ và `v3-qa` (chỉ nhận `v3-qa` khi `VC_UPDATE_ALLOW_QA=1`) | PASS |
| — PowerShell thật (`Get-VcSettings`, `ProgramData` tạm): không có settings / rỗng / địa chỉ cũ ⇒ kênh v3; địa chỉ riêng ⇒ giữ | PASS |
| `test/release-preflight.spec.ts` (16 test; repo git tạm + remote bare riêng): khớp; tracking cục bộ cũ nhưng remote đã có commit mới (FAIL rồi PASS sau khi pull); chưa push; thiếu upstream; sai remote; remote không truy cập được (không lộ URL); branch bị xóa trên remote; HEAD detached; kênh cũ/sai kênh; mặc định bộ cài sai kênh; `-AllowDirty` đòi `-dev`/`-qa`; kiểm stage; `release.ps1` chạy preflight trước build | **PASS 16/16** |
| Preflight với remote **thật** (CRM `origin`, Sender `vetclinic`) | Khớp commit trên remote; FAIL **chỉ** vì thay đổi chưa commit (đúng) |
| `release.ps1` thật: `-AllowDirty 0.3.0-pc` trên clone sạch; bản chính thức trên cây chưa commit | Cả hai dừng trước build, không tạo thư mục build |
| `npm test` (toàn bộ unit) | **PASS 75/75** |
| Build backend / web | PASS / PASS |
| Parse PowerShell `VetclinicCrm.psm1`, `release.ps1` (còn BOM) | PASS |
| `git diff --check` | PASS |
| Khóa Platform production | Không đổi: `vetclinic-crm-pc-prod-20260926`, fingerprint `3697bd76…7810` |
| Khóa công khai xác minh cập nhật `update-public-key.pem` | Không đổi so với HEAD |
| `src/` (backend) | Không đổi ở vòng này. Client ID/Secret cục bộ, bắt buộc kích hoạt, phạm vi chi nhánh theo nguồn giữ nguyên. |
| Test Platform giả / bản PC / VPS integration | NOT RUN vòng này (backend không đổi; lượt trước trên `7b699ac`: 27/27, 18/18, 117/117) |
| Upload/đăng manifest thật, cài máy sạch, nâng cấp `.exe` trên máy thử | NOT RUN (chờ commit và phát hành đồng bộ) |

Sự cố trong lúc test: bản đầu của `update-channel.spec.ts` gọi công cụ cập nhật đồng bộ (`spawnSync`), trong khi máy chủ HTTP giả chạy cùng tiến trình ⇒ treo. Em đã dừng đúng các tiến trình của lượt treo theo PID, rồi sửa sang gọi bất đồng bộ.

## 6. Còn chờ Platform / BLOCKED phát hành
1. Doanh nghiệp thử trên production + mã kích hoạt cấp **ngay trước** lượt QA (không dùng khách thật).
2. Kích hoạt thật với Platform production trên máy thử.
3. Cầu nguồn B2B ↔ CRM PC còn khác contract xác thực/revalidation (blocker riêng).
4. Codex review + commit/push; build chính thức; cài mới + nâng cấp `.exe` trên máy thử; upload **vào `/tai-ve/crm-pc/v3/`**, manifest đăng sau cùng.

## 7. Điểm cần chốt
- **Tên kênh đã chốt:** `/tai-ve/crm-pc/v3/` và `product "VETCLINIC CRM PC v3"`. `v3` là thế hệ kiến trúc CRM PC, không chỉ riêng phiên bản 0.3.x; giữ kênh này cho đến khi có thay đổi không tương thích cần kênh thế hệ mới.
- **Địa chỉ kênh cũ trên web:** nên để trống (không có file) hoặc giữ nguyên. Không cần đăng gì cho 0.2.x.
