# VETCLINIC CRM — Kiến trúc bản chạy trên PC (Standalone PC Edition)

Trạng thái: **Đã chạy kỹ thuật** trên máy dev của anh Huy (LOCAL, dữ liệu giả). Chưa được anh Huy duyệt, chưa Codex review,
chưa commit. **Không phải production-ready.**

> **Cập nhật 2026-09-26:** Platform Admin là control plane cấp phép (mã kích hoạt một lần, gói, chi nhánh, hạn mức, offline ≤ 72h). Xem `platform-device-contract-v1.md` và `qa-platform-device-agent-2026-09-26.md`. Khóa API cục bộ (Client ID/Secret) vẫn do CRM PC tự sinh, không đổi.

## 1. Sơ đồ

```
                         PC Windows của khách (không cần VPS, không cần Platform Admin)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │  Trình duyệt ──http://127.0.0.1:47100──►  VetclinicCrmApi  (NestJS: API + giao diện CRM)       │
 │                                             │  tài khoản cục bộ, phiên HttpOnly + CSRF          │
 │  Phần mềm phòng khám/bán hàng ──HMAC──────► │  POST /api/v1/care-jobs (khóa API tự sinh)       │
 │  (cùng máy hoặc LAN khi bật thủ công)       │                                                   │
 │                                             ▼                                                   │
 │                                  PostgreSQL 17 (VetclinicCrmDb, 127.0.0.1:55432, TZ=UTC)       │
 │                                   ├─ vetclinic_crm    (role crm_app)                            │
 │                                   └─ vetclinic_sender (role sender_app)                         │
 │                                             ▲                                                   │
 │  VetclinicCrmWorker (NestJS, không mở cổng) │ hàng đợi: consent → hạn 12 giờ → hỏi lại nguồn   │
 │     ├──HMAC VCSC1──► hệ thống nguồn (Source Connector v1: lịch hẹn / công nợ)                  │
 │     └──HMAC v2─────► VetclinicCrmSender (chỉ-sender, 127.0.0.1:47110) ──► Zalo (zca-js)        │
 │                         ▲ health callback HMAC ─────────────────────────┘                      │
 │  Secret: C:\ProgramData\VETCLINIC CRM\secrets\secrets.dpapi (DPAPI LocalMachine + ACL)          │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Khác biệt bản VPS và bản PC

| | Bản VPS (hiện tại) | Bản PC |
|---|---|---|
| Module Nest | `AppModule` | `StandaloneAppModule` (`DEPLOYMENT_MODE=standalone`) |
| Đăng nhập | SSO Platform (RS256, code exchange) | Tài khoản cục bộ (scrypt), thiết lập lần đầu trên chính máy |
| Doanh nghiệp | nhiều tenant, do Platform cấp | **1 doanh nghiệp / 1 PC** (bảng `StandaloneInstance` id=1) |
| Gói / quyền dùng | entitlement từ sự kiện Platform | luôn ACTIVE; không có sự kiện Platform |
| Xóa tenant | vòng đời do Platform điều khiển | không có (gỡ cài + xóa dữ liệu tại máy) |
| Credential hệ thống ngoài | Platform cấp qua `/installations` | CRM tự sinh; chủ doanh nghiệp xoay/thu hồi |
| Nguồn dữ liệu | PETCLINIC (Bearer), B2B (qua Platform) | Source Connector v1 (HMAC, cùng khóa tự sinh) |
| Bàn vận hành `/admin/*` | có (mạng nội bộ vận hành) | **không đăng ký** |
| Dừng khẩn cấp | vận hành viên | chủ/quản trị doanh nghiệp (cả máy) |
| Tin trễ | không giới hạn (như cũ) | trễ **hơn 12 giờ** thì hủy `EXPIRED_WHILE_OFFLINE` |
| Worker | chung tiến trình API | dịch vụ riêng (`PROCESS_ROLE=worker`) |
| Sender | ZaloCRM đầy đủ + Redis (Docker) | chế độ chỉ-sender, nonce PostgreSQL, không Redis |
| Hạ tầng | Docker trên VPS | 4 Windows Service (WinSW + pg_ctl), không Docker |
| Cookie phiên | `__Host-` + Secure (https) | không Secure (http://127.0.0.1); SameSite=Strict |

Các bảo đảm gửi giữ nguyên ở cả hai bản:
- Idempotency theo `deliveryAttemptId`.
- Kết quả UNKNOWN thì không tự gửi lại.
- Chỉ failover khi NOT_SENT chắc chắn.
- Chỉ nhắn bạn bè hoặc hội thoại đã có, không kết bạn và không nhắn người lạ.
- Giữ quiet hours, hạn mức ngày và consent theo commit `5581357`.

## 3. Dịch vụ, cổng, thư mục, secret

Xem `packaging/windows/README.md`. Tóm tắt:
- **Dịch vụ:** `VetclinicCrmDb`, `VetclinicCrmApi`, `VetclinicCrmWorker`, `VetclinicCrmSender`. Cả 4 tự khởi động (delayed) và tự chạy lại khi lỗi.
- **Cổng:** 55432 (PostgreSQL), 47100 (CRM), 47110 (Sender). Tất cả chỉ nghe `127.0.0.1`.
- **Chương trình:** `C:\Program Files\VETCLINIC CRM\app\<version>\`.
- **Dữ liệu:** `C:\ProgramData\VETCLINIC CRM\{db,secrets,logs,run,sender,backup}`.
- **Secret:** 14 khóa (thêm `BACKUP_KEY`, `RECOVERY_WRAP`), chỉ nêu tên trong README, lưu trong `secrets.dpapi`. Không có secret nào trong source hay bộ cài.

## 4. Runbook

### 4.0 Phát hành (VETCLINIC) — ĐÃ CHẠY (LOCAL)
- **Lệnh:** `release.ps1` chạy lần lượt: build tái lập → bộ cài `VETCLINIC-CRM-Setup-<ver>.exe` (Inno Setup, chưa ký số) → gói cập nhật `vetclinic-crm-<ver>.zip` → `manifest.json` ký Ed25519 + `SHA256SUMS.txt`.
- **Đưa lên web:** tải cả thư mục `build\release\<ver>\` lên web VETCLINIC (HTTPS).
- **Khóa bí mật ký cập nhật** (`release-keys\vetclinic-crm-update-private.pem`) chỉ VETCLINIC giữ, không nằm trong repo hay bộ cài.
  Mất khóa này thì các máy đã cài không nhận được cập nhật tự động nữa: phải phát hành bộ cài mới có khóa công khai mới và khách cài lại.

### 4.1 Khách cài mới — ĐÃ CHẠY (LOCAL)
1. Khách tải `VETCLINIC-CRM-Setup-<ver>.exe`. SmartScreen sẽ cảnh báo vì chưa ký số: bấm "More info → Run anyway". Chọn "Cài mới".
2. Cuối quá trình cài, bộ cài hiện **khóa khôi phục một lần**. Khách phải xác nhận đã lưu mới đi tiếp.
3. Mở `http://127.0.0.1:47100/` → thiết lập doanh nghiệp → lưu **khóa API** (hiện một lần).
4. Biểu tượng khay tự bật mỗi lần đăng nhập Windows. Sao lưu chạy lúc 02:30 hằng ngày, kiểm tra cập nhật lúc 03:15 và 15 phút sau khi mở máy.
- Cài im lặng (cho kỹ thuật viên): `Setup.exe /VERYSILENT /RECOVERYOUT="<file>"`. Cài lỗi thì mã thoát là 10.

### 4.2 Gỡ cài — ĐÃ CHẠY (LOCAL)
- Gỡ qua "Apps & features" hoặc `unins000.exe`: gỡ dịch vụ, tác vụ lịch, biểu tượng khay và chương trình. **Dữ liệu được giữ lại** trong `C:\ProgramData\VETCLINIC CRM`.
- Muốn xóa cả dữ liệu: chạy `uninstall.ps1 -DeleteData -ConfirmText "XOA TOAN BO DU LIEU"`.

### 4.3 Cập nhật — ĐÃ CHẠY (LOCAL, web giả lập bằng http://127.0.0.1)
- **Tự động:** tác vụ `check-update.ps1` tải `manifest.json` + `.sig` → kiểm chữ ký Ed25519 → so phiên bản → tải gói → kiểm SHA-256 và kích thước → chạy `update.ps1`.
- **Trình tự trong `update.ps1`:**
  1. Bật dừng khẩn cấp, chờ đến khi không còn tin PROCESSING (quá 10 phút thì hủy cập nhật).
  2. Sao lưu (sao lưu lỗi thì hủy cập nhật).
  3. Dừng dịch vụ, chạy migrate forward-only (migrate lỗi thì chạy lại bản cũ).
  4. Chuyển dịch vụ sang bản mới và kiểm tra sức khỏe. Không khỏe thì **quay về bản cũ**; database không bị rollback phá hủy.
  5. Trả dừng khẩn cấp về trạng thái trước đó. Giữ lại bản trước để có thể quay về bằng tay.
- **Cập nhật thủ công:** chạy bộ cài `.exe` bản mới trên máy đã cài. Bộ cài tự nhận ra đây là cập nhật và gọi `update.ps1`.
- **Web không phản hồi, chữ ký sai hoặc SHA-256 sai:** không cập nhật, CRM vẫn chạy bình thường.

### 4.4 Sao lưu / kiểm tra / thử khôi phục — ĐÃ CHẠY (LOCAL)
- **Sao lưu:** `backup.ps1` chạy hằng ngày, hoặc bấm "Sao lưu ngay" ở khay. Kết quả là 1 file `.vcbak` (pg_dump 2 database, mã hóa AES-256-GCM theo từng khối, phát hiện được file bị sửa hoặc bị cắt cụt). Mặc định giữ 14 bản. Có thể chép thêm ra ổ ngoài qua `settings.json → backupExtraDir`.
- **Kiểm tra:** `backup.ps1 -Verify <file>` (giải mã toàn bộ + `pg_restore --list`).
- **Thử khôi phục:** `backup.ps1 -TestRestore <file>` (nạp vào database tạm, đếm dữ liệu, rồi xóa database tạm).
- **Khóa khôi phục (khách tự giữ):**
  - 40 ký tự dạng `XXXX-XXXX-…`, hiện một lần lúc cài, không lưu trên máy.
  - Mỗi file `.vcbak` mang theo "gói khóa" (khóa sao lưu + khóa dữ liệu + khóa Sender) được mã hóa bằng scrypt(khóa khôi phục).
  - Khóa phiên Zalo **không** nằm trong gói khóa.

### 4.5 PC hỏng — ĐÃ CHẠY (LOCAL, giả lập bằng cách xóa sạch chương trình + dữ liệu + secret)
1. Trên máy mới, chạy bộ cài `.exe`, chọn "Khôi phục từ bản sao lưu", chọn file `.vcbak` và nhập khóa khôi phục.
2. Bộ cài mở gói khóa, tạo PostgreSQL mới, nạp dữ liệu, rồi chạy migrate (bản cài mới hơn bản sao lưu vẫn được).
3. Sau khôi phục:
   - Đăng nhập bằng tài khoản cũ.
   - **Khóa API cũ của hệ thống ngoài vẫn dùng được.**
   - Dừng khẩn cấp giữ nguyên trạng thái lúc sao lưu.
   - Kênh Zalo cần **quét QR lại**.
4. Các bản sao lưu mới trên máy mới vẫn mở được bằng **cùng** khóa khôi phục.
5. Nhập sai khóa thì bị từ chối, không cài gì thêm.
6. Mất khóa khôi phục thì **không khôi phục được**.

### 4.6 Hỗ trợ từ xa — ĐÃ CHẠY (LOCAL)
- **Gói chẩn đoán:** "Tạo gói chẩn đoán" ở khay (hoặc chạy `diag.ps1`) tạo file zip khoảng 1–2 KB trên Desktop.
  - Có: phiên bản, trạng thái dịch vụ, sức khỏe, số liệu hàng đợi, trạng thái sao lưu và cập nhật, tên mã lỗi, thông tin máy.
  - **Không có:** secret, dữ liệu khách, nội dung tin nhắn, file log thô.
- **Khay hệ thống:** chạy `tray.ps1 -StatusOnly` để in đúng nội dung mà biểu tượng khay đang hiển thị.

## 5. Pháp lý (AGPL Sender)

- **Phải cung cấp mã nguồn:** cài Sender lên máy khách là "conveying". Bộ cài kèm `sender\sender-source.zip` (mã nguồn tương ứng), `LICENSE`, `NOTICE` và `THIRD-PARTY-LICENSES.md`.
- **Ghi công khi không có giao diện ZaloCRM:** chế độ chỉ-sender không có giao diện ZaloCRM (nơi có banner ghi công theo §7b). Ghi công, NOTICE và link mã nguồn được phục vụ tại `http://127.0.0.1:47110/legal`. Trang "Giấy phép" trong CRM (`#/giay-phep`, xem được cả khi chưa đăng nhập, có link ở màn đăng nhập và hồ sơ) và mục "Giấy phép và ghi công" trên khay hiển thị nguyên văn nội dung đó. Trang thông tin đầu bộ cài cũng ghi công tác giả và link mã nguồn.
- **Cần luật sư:** cách này có đủ đáp ứng §7b hay không cần luật sư xác nhận **trước khi giao khách thật**.
- **Tên sản phẩm:** không dùng tên "ZaloCRM" (§7e).
